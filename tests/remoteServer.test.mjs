import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createRemoteServer} from '../dist/remote/remoteServer.js';
import {createWriteExecutor} from '../dist/remote/writeExecutor.js';
import {buildCatalogScript} from '../dist/remote/catalog.js';
import {configSchema} from '../dist/remote/config.js';

async function connection(server,run){
 const client=new Client({name:'remote-server-test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 try{await run(client);}finally{await client.close();await server.close();}
}

test('read-write MCP registers mutations, persists exact replay, and annotates destructive actions',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'omnifocus-remote-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 let writes=0;
 const writer=createWriteExecutor({directory,runner:async()=>{writes++;return JSON.stringify({ok:true,item:{type:'tag',id:'tag1',name:'test',nameTruncated:false,parentTagId:null,status:'active'}});}});
 await connection(createRemoteServer({writer}),async client=>{
  const {tools}=await client.listTools();assert.equal(tools.length,11);
  for (const name of ['create_task','update_task','create_project','update_project','create_tag','update_tag','delete_item']) {
    const tool=tools.find(x=>x.name===name);
    assert.ok(tool.inputSchema.properties.idempotencyKey, name+' must publish idempotencyKey');
    assert.ok(tool.inputSchema.required.includes('idempotencyKey'));
  }
  for (const field of ['type','itemId','confirmId']) assert.ok(tools.find(x=>x.name==='delete_item').inputSchema.required.includes(field));
  const deletion=tools.find(x=>x.name==='delete_item');assert.equal(deletion.annotations.destructiveHint,true);assert.equal(deletion.annotations.readOnlyHint,false);
  const args={name:'test',idempotencyKey:'test-action-001'};
  const first=await client.callTool({name:'create_tag',arguments:args});assert.equal(first.isError,false);
  const again=await client.callTool({name:'create_tag',arguments:args});assert.deepEqual(again,first);assert.equal(writes,1);
  const conflict=await client.callTool({name:'create_tag',arguments:{...args,name:'different'}});assert.equal(conflict.isError,true);
  const invalid=await client.callTool({name:'delete_item',arguments:{type:'tag',itemId:'tag1',confirmId:'other',idempotencyKey:'test-delete-001'}});assert.equal(invalid.isError,true);assert.equal(writes,1);
  const status=await client.callTool({name:'get_write_status',arguments:{idempotencyKey:args.idempotencyKey}});assert.equal(JSON.parse(status.content[0].text).outcome,'succeeded');
 });
});

test('write mode needs an external ledger directory and read-only remains the default',()=>{
 const auth={mode:'local-bearer',token:'a'.repeat(64)};
 assert.equal(configSchema.parse({auth}).access,'read-only');
 assert.equal(configSchema.safeParse({auth,access:'read-write'}).success,false);
 assert.equal(configSchema.safeParse({auth,access:'read-write',ledgerDirectory:process.cwd()+'/ledger'}).success,false);
 assert.equal(configSchema.safeParse({auth,access:'read-write',ledgerDirectory:'/tmp/private-omnifocus-ledger'}).success,true);
});

test('catalog performs bounded exact-ID reads with literal names',()=>{
 const items=Array.from({length:4},(_,index)=>({id:{primaryKey:`id${index}`},name:`quoted " item ${index}`,parent:null}));
 const script=buildCatalogScript({kind:'tags',search:'quoted "',limit:2});
 const scope={Application:()=>({evaluateJavascript:code=>vm.runInNewContext(code,{flattenedTags:items})})};
 const data=JSON.parse(vm.runInNewContext(script+';run()',scope));
 assert.equal(data.items.length,2);assert.equal(data.hasMore,true);assert.equal(data.items[0].id,'id0');assert.equal(data.items[0].name,'quoted " item 0');
});
