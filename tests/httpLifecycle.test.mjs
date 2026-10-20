import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { request } from 'node:http';
import { createHttpApp } from '../dist/remote/http.js';

const token = 'a'.repeat(64);
const headers = {host:'localhost:8787', authorization:`Bearer ${token}`, accept:'application/json, text/event-stream', 'content-type':'application/json'};
const body = JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'});

function post(url, data = body) {
  let req;
  const response = new Promise((resolve, reject) => {
    req = request(`${url}/mcp`, {method:'POST', headers}, res => {
      let text = '';
      res.on('data', chunk => {text += chunk;});
      res.on('end', () => resolve({status:res.statusCode, headers:res.headers, body:JSON.parse(text)}));
    });
    req.on('error', reject);
    req.end(data);
  });
  // A deliberately disconnected request rejects before the fixture finishes.
  response.catch(() => {});
  return {req, response};
}

test('HTTP admission releases slots after parser failures, completion, and disconnect', {timeout:15000}, async () => {
  const events = new EventEmitter();
  const active = [];
  let closed = 0;
  const app = createHttpApp({port:8787,auth:{mode:'local-bearer',token}}, {createServer() {
    let release;
    const waiting = new Promise((_resolve, reject) => {release = () => reject(new Error('fixture request complete'));});
    return {
      async connect() {active.push({release}); events.emit('connected'); await waiting;},
      async close() {closed++; release(); events.emit('closed'); throw new Error('fixture cleanup failure');},
    };
  }});
  const server = app.listen(0,'127.0.0.1');
  await once(server,'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const requests = [];
  async function admitted() {
    const connected = once(events,'connected');
    const pending = post(url); requests.push(pending);
    await Promise.race([connected, pending.response.then(response => {
      assert.fail(`Request returned ${response.status} before admission`);
    })]);
    return pending;
  }
  try {
    for (let i=0; i<20; i++) {
      const malformed = await post(url,'{').response;
      assert.equal(malformed.status,400);
      assert.deepEqual(malformed.body,{error:'Invalid request'});
      const oversized = await post(url,JSON.stringify({data:'x'.repeat(70000)})).response;
      assert.equal(oversized.status,413);
      assert.deepEqual(oversized.body,{error:'Request too large'});
    }
    assert.equal(active.length,0,'body failures never construct an MCP server');
    for (let i=0; i<16; i++) await admitted();
    const busy = await post(url).response;
    assert.equal(busy.status,503);
    assert.equal(busy.headers['retry-after'],'2');
    assert.deepEqual(busy.body,{error:'Server busy'});
    assert.equal(active.length,16);

    const completedCleanup = once(events,'closed');
    active[0].release();
    assert.equal((await requests[0].response).status,500);
    await completedCleanup;
    await admitted();
    assert.equal(active.length,17,'completion frees a slot');

    const disconnectedCleanup = once(events,'closed');
    requests[1].req.destroy();
    await disconnectedCleanup;
    assert.ok(closed>=2,'disconnect closes the MCP server');
    await admitted();
    assert.equal(active.length,18,'disconnect frees a slot');
    assert.equal((await post(url).response).status,503);
  } finally {
    for (const entry of active) entry.release();
    for (const pending of requests) pending.req.destroy();
    await Promise.allSettled(requests.map(pending=>pending.response));
    await new Promise(resolve=>server.close(resolve));
  }
});
