import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: options.method ?? 'GET', headers: options.headers }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({status:res.statusCode,headers:{get:name=>res.headers[name.toLowerCase()]},json:async()=>JSON.parse(body)}));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createHttpApp } from '../dist/remote/http.js';
import { configSchema } from '../dist/remote/config.js';

const token = 'a'.repeat(64);
async function serve(config, dependencies, run) {
  const server = createHttpApp(config, dependencies).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try { await run(url); } finally { await new Promise(resolve => server.close(resolve)); }
}
const headers = { host: 'localhost:8787', authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
const local = { port: 8787, auth: { mode: 'local-bearer', token } };
const rpc = (method, params = {}) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });

test('config fails closed without auth, exact identity, or canonical URL', () => {
  assert.equal(configSchema.safeParse({}).success, false);
  assert.equal(configSchema.safeParse({ auth: { mode: 'local-bearer', token: 'short' } }).success, false);
  for (const publicUrl of ['http://example.com/mcp', 'https://example.com/', 'https://user@example.com/mcp', 'https://example.com/mcp?x=1']) {
    assert.equal(configSchema.safeParse({ auth: { mode: 'cloudflare', publicUrl, issuer: 'https://team.cloudflareaccess.com', audience: 'aud', allowedEmails: ['alex@example.com'] } }).success, false);
  }
});

test('local authentication, host/origin checks, body limits, and write rejection', async () => {
  await serve(local, {}, async url => {
    for (const authorization of ['', 'Bearer wrong']) {
      const response = await fetch(`${url}/mcp`, { method: 'POST', headers: { ...headers, authorization }, body: rpc('tools/list') });
      assert.equal(response.status, 401);
    }
    for (const extra of [{host:'attacker.example'}, {origin:'https://attacker.example'}]) {
      const response = await fetch(`${url}/mcp`, { method:'POST', headers:{...headers,...extra}, body:rpc('tools/list') });
      assert.equal(response.status,403);
    }
    const oversized = await fetch(`${url}/mcp`, {method:'POST',headers,body:JSON.stringify({data:'x'.repeat(70000)})});
    assert.equal(oversized.status,413);
    const listed = await fetch(`${url}/mcp`, {method:'POST',headers,body:rpc('tools/list')});
    assert.equal(listed.status,200);
    const tools=(await listed.json()).result.tools;
    assert.deepEqual(tools.map(tool=>tool.name).sort(),['get_task','list_items','query_tasks']);
    for (const tool of tools) assert.equal(tool.annotations.readOnlyHint,true);
    for (const name of ['create_task','update_task','create_project','update_project','create_tag','update_tag','delete_item','add_omnifocus_task','add_project','edit_item','remove_item','batch_add_items','batch_remove_items','batch_edit_items']) {
      const response = await fetch(`${url}/mcp`, {method:'POST',headers,body:rpc('tools/call',{name,arguments:{}})});
      const result=await response.json();
      assert.ok(result.error || result.result?.isError, `${name} must be rejected`);
    }
    const invalid = await fetch(`${url}/mcp`, {method:'POST',headers,body:rpc('tools/call',{name:'query_tasks',arguments:{limit:101}})});
    assert.equal((await invalid.json()).result.isError,true);
    const get = await fetch(`${url}/mcp`, {headers});
    assert.equal(get.status,405);
  });
});

test('Cloudflare assertion verifies signature, issuer, audience, expiry and exact email on every request', async () => {
  const {privateKey,publicKey}=await generateKeyPair('RS256');
  const jwk=await exportJWK(publicKey); jwk.kid='test';
  const config={port:8787,auth:{mode:'cloudflare',publicUrl:'https://focus.example.com/mcp',issuer:'https://team.cloudflareaccess.com',audience:'aud',allowedEmails:['alex@example.com']}};
  async function sign(overrides={}) {
    return new SignJWT({type:'app',email:'alex@example.com',...overrides})
      .setProtectedHeader({alg:'RS256',kid:'test'}).setIssuedAt().setSubject('alex')
      .setIssuer(overrides.iss??config.auth.issuer).setAudience(overrides.aud??'aud').setExpirationTime(overrides.exp??'5m').sign(privateKey);
  }
  await serve(config,{key:createLocalJWKSet({keys:[jwk]})},async url=>{
    const meta=await fetch(`${url}/.well-known/oauth-protected-resource/mcp`,{headers:{host:'focus.example.com'}});
    const metadata=await meta.json();
    assert.equal(metadata.resource,config.auth.publicUrl);
    assert.deepEqual(metadata.authorization_servers,[config.auth.issuer]);
    for(const jwt of ['', 'forged',await sign({email:'other@example.com'}),await sign({aud:'wrong'}),await sign({iss:'https://evil.example'}),await sign({exp:1}),await sign({type:'service'})]) {
      const response=await fetch(`${url}/mcp`,{method:'POST',headers:{...headers,host:'focus.example.com','cf-access-jwt-assertion':jwt},body:rpc('tools/list')});
      assert.equal(response.status,401);
      assert.match(response.headers.get('www-authenticate'),/resource_metadata/);
    }
    const claims = {type:'app', email:'alex@example.com', sub:'alex', iss:config.auth.issuer, aud:'aud', iat:Math.floor(Date.now()/1000), exp:Math.floor(Date.now()/1000)+300};
    const otherKey = await generateKeyPair('RS256');
    const cases = [['wrong signature', claims, otherKey.privateKey], ['future nbf', {...claims, nbf:Math.floor(Date.now()/1000)+300}, privateKey]];
    for (const claim of ['exp','iat','sub','email','iss','aud']) {
      const missing = {...claims}; delete missing[claim];
      cases.push([`missing ${claim}`, missing, privateKey]);
    }
    for (const [name, payload, signingKey] of cases) {
      const jwt = await new SignJWT(payload).setProtectedHeader({alg:'RS256',kid:'test'}).sign(signingKey);
      const rejected = await fetch(`${url}/mcp`, {method:'POST',headers:{...headers,host:'focus.example.com','cf-access-jwt-assertion':jwt},body:rpc('tools/list')});
      assert.equal(rejected.status,401,name);
    }
    const valid=await fetch(`${url}/mcp`,{method:'POST',headers:{...headers,host:'focus.example.com','cf-access-jwt-assertion':await sign()},body:rpc('tools/list')});
    assert.equal(valid.status,200);
    const again=await fetch(`${url}/mcp`,{method:'POST',headers:{...headers,host:'focus.example.com'},body:rpc('tools/list')});
    assert.equal(again.status,401);
  });
});


test('write ledger rejects every repository descendant but permits sibling directories', () => {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  for (const directory of [repository, resolve(repository, 'ledger'), resolve(repository, '..ledger'), resolve(repository, '..ledger/nested')]) {
    assert.equal(configSchema.safeParse({...local, access:'read-write', ledgerDirectory:directory}).success, false, directory);
  }
  for (const directory of [resolve(repository, '../private-ledger'), `${repository}-ledger`]) {
    assert.equal(configSchema.safeParse({...local, access:'read-write', ledgerDirectory:directory}).success, true, directory);
  }
});

test('server construction failures return a safe internal error', async () => {
  await serve(local, {createServer() { throw new Error('private construction details'); }}, async url => {
    const response = await fetch(`${url}/mcp`, {method:'POST', headers, body:rpc('tools/list')});
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {error:'Request failed'});
  });
});


test('key resolver rejection fails authentication without exposing resolver details', async () => {
  const {privateKey} = await generateKeyPair('RS256');
  const jwt = await new SignJWT({}).setProtectedHeader({alg:'RS256'}).sign(privateKey);
  const config = {port:8787,auth:{mode:'cloudflare',publicUrl:'https://focus.example.com/mcp',issuer:'https://team.cloudflareaccess.com',audience:'aud',allowedEmails:['alex@example.com']}};
  await serve(config,{key:async()=>{throw new Error('private resolver details');}},async url=>{
    const response = await fetch(`${url}/mcp`,{method:'POST',headers:{...headers,host:'focus.example.com','cf-access-jwt-assertion':jwt},body:rpc('tools/list')});
    assert.equal(response.status,401);
    assert.deepEqual(await response.json(),{error:'Authentication required'});
  });
});

test('Cloudflare accepts each explicitly allowed email and rejects every other identity', async () => {
  const {privateKey, publicKey} = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); jwk.kid = 'allowlist';
  const allowedEmails = ['primary@example.com', 'alias@example.net'];
  const config = {port:8787, auth:{mode:'cloudflare', publicUrl:'https://focus.example.com/mcp', issuer:'https://team.cloudflareaccess.com', audience:'aud', allowedEmails}};
  await serve(config, {key:createLocalJWKSet({keys:[jwk]})}, async url => {
    for (const [email, expected] of [...allowedEmails.map(email => [email, 200]), ['other@example.com', 401], ['alias@example.net.evil', 401], ['ALIAS@example.net', 401], [' alias@example.net ', 401], [allowedEmails, 401], [null, 401]]) {
      const jwt = await new SignJWT({type:'app', email}).setProtectedHeader({alg:'RS256',kid:'allowlist'})
        .setIssuedAt().setSubject('test-user').setIssuer(config.auth.issuer).setAudience('aud').setExpirationTime('5m').sign(privateKey);
      const response = await fetch(`${url}/mcp`, {method:'POST', headers:{...headers, host:'focus.example.com', 'cf-access-jwt-assertion':jwt}, body:rpc('tools/list')});
      assert.equal(response.status, expected, JSON.stringify(email));
    }
  });
  assert.equal(configSchema.safeParse(config).success, true);
  for (const allowedEmails of [undefined, [], ['*'], ['bad-address'], Array(21).fill('a@example.com')]) {
    assert.equal(configSchema.safeParse({...config, auth:{...config.auth, allowedEmails}}).success, false);
  }
  assert.equal(configSchema.safeParse({...config, auth:{...config.auth, allowedEmails:undefined, allowedEmail:'primary@example.com'}}).success, false);
  assert.equal(configSchema.safeParse({...config, auth:{...config.auth, allowedEmail:'primary@example.com'}}).success, false);
});
