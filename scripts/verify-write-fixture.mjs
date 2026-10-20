import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {createWriteExecutor} from '../dist/remote/writeExecutor.js';
import {queryTasks,getTask} from '../dist/remote/automation.js';
import {listItems} from '../dist/remote/catalog.js';

const directory=process.env.OMNIFOCUS_TEST_DIRECTORY;
if(!directory?.startsWith('/'))throw new Error('Set OMNIFOCUS_TEST_DIRECTORY to a private absolute fixture directory');
const run=randomUUID(); const prefix=`OmniFocus MCP verification ${run}`;
await mkdir(directory,{recursive:true,mode:0o700});
const ledger=`${directory}/ledger`;
let writer=createWriteExecutor({directory:ledger});
const manifest={run,prefix,created:[],checks:[]};
const save=()=>writeFile(`${directory}/${run}.json`,JSON.stringify(manifest,null,2),{mode:0o600});
async function mutate(name,args,key=randomUUID()) {
 const input={...args,idempotencyKey:key};
 const result=await writer.execute(name,input);
 if(!result.ok)throw new Error(`${name}: ${JSON.stringify(result)}`);
 return result;
}
async function created(name,args,type){const result=await mutate(name,args);manifest.created.push({type,id:result.item.id,deleted:false});await save();return result.item.id;}
async function remove(type,id){await mutate('delete_item',{type,itemId:id,confirmId:id,includeChildren:true});manifest.created.find(x=>x.type===type&&x.id===id).deleted=true;await save();}
try {
 const projectId=await created('create_project',{name:prefix,note:'Disposable integration fixture',sequential:false},'project');
 const tagId=await created('create_tag',{name:prefix},'tag');
 const secondTagId=await created('create_tag',{name:`${prefix} child`,parentTagId:tagId},'tag');
 const project=await mutate('update_project',{projectId,name:`${prefix} edited`,status:'onHold',sequential:true});
 assert.equal(project.item.status,'onHold');assert.equal(project.item.sequential,true);
 await mutate('update_project',{projectId,status:'active',sequential:false});
 const tag=await mutate('update_tag',{tagId:secondTagId,name:`${prefix} child edited`,status:'onHold',parentTagId:null});
 assert.equal(tag.item.status,'onHold');assert.equal(tag.item.parentTagId,null);
 await mutate('update_tag',{tagId:secondTagId,status:'active',parentTagId:tagId});
 const key=randomUUID();const args={name:`${prefix} task`,projectId,note:'Quotes " \\ Unicode 日本語\nSecond line',flagged:true,tagIds:[tagId],dueDate:'2026-12-10T12:30:00+01:00',deferDate:'2026-12-09T09:00:00+01:00',estimatedMinutes:15};
 const original=await mutate('create_task',args,key);const taskId=original.item.id;
 manifest.created.push({type:'task',id:taskId,deleted:false});await save();
 writer=createWriteExecutor({directory:ledger});
 const replay=await mutate('create_task',args,key);assert.equal(replay.item.id,taskId);
 const matching=await queryTasks({search:`${prefix} task`,limit:10});assert.equal(matching.tasks.filter(x=>x.id===taskId).length,1);
 assert.equal(matching.tasks.length,1);manifest.checks.push('create idempotency after executor restart');
 const read=await getTask({taskId,includeNotes:true});assert.equal(read.task.note,args.note);assert.equal(read.task.flagged,true);assert.equal(read.task.dueDate,'2026-12-10T11:30:00.000Z');
 const parentId=await created('create_task',{name:`${prefix} parent`,projectId},'task');
 await mutate('update_task',{taskId,parentTaskId:parentId,name:`${prefix} edited task`,flagged:false,dueDate:null,deferDate:null,tagIds:[secondTagId],estimatedMinutes:30});
 let updated=await getTask({taskId});assert.equal(updated.task.dueDate,null);assert.equal(updated.task.flagged,false);assert.deepEqual(updated.task.tags.map(t=>t.id),[secondTagId]);
 const completed=await mutate('update_task',{taskId,completed:true});assert.equal(completed.item.completed,true);
 assert.equal((await getTask({taskId})).task.status,'completed');
 await mutate('update_task',{taskId,completed:false,projectId:null});
 updated=await getTask({taskId});assert.equal(updated.task.inInbox,true);assert.notEqual(updated.task.status,'completed');
 await mutate('update_task',{taskId,projectId});
 assert.equal((await getTask({taskId})).task.project.id,projectId);
 for(const kind of ['projects','tags','folders','perspectives']){const result=await listItems({kind,limit:1});assert.ok(Array.isArray(result.items));}
 manifest.checks.push('task create/edit/move/complete/reopen, dates/tags/notes; project/tag edits; catalog');await save();
 await remove('task',taskId);assert.equal((await getTask({taskId})).task,null);
 await remove('task',parentId);await remove('tag',secondTagId);await remove('tag',tagId);await remove('project',projectId);
 manifest.checks.push('all disposable items deleted and task absence read back');await save();
 console.log(JSON.stringify({ok:true,checks:manifest.checks,manifest:`${directory}/${run}.json`}));
} finally {
 for(const item of [...manifest.created].reverse()){
  if(item.deleted)continue;
  try{await remove(item.type,item.id);}catch{console.error(JSON.stringify({cleanupRequired:true,type:item.type,id:item.id,manifest:`${directory}/${run}.json`}));}
 }
}
