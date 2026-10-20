import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createWriteFixture } from '../scripts/writeFixture.mjs';

async function fixture(t, execute) {
  const directory = await mkdtemp(join(tmpdir(), 'omnifocus-manifest-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return createWriteFixture({ directory, execute, run: 'fixture-run' });
}

test('the first uncertain create leaves its exact intent and key for manual reconciliation', async t => {
  const calls = [];
  let savedBeforeExecute;
  const tracked = await fixture(t, async (operation, input) => {
    calls.push({ operation, input });
    try { savedBeforeExecute = JSON.parse(await readFile(tracked.manifestPath, 'utf8')); } catch {}
    return { ok: false, outcome: 'unknown', errorCode: 'OUTCOME_UNKNOWN', idempotencyKey: input.idempotencyKey };
  });
  assert.equal((await lstat(tracked.manifestPath)).mode & 0o777, 0o600);
  const args = { name: tracked.manifest.prefix, note: 'Disposable integration fixture' };
  await assert.rejects(tracked.created('create_project', args, 'project', 'stable-fixture-key'));
  assert.ok(savedBeforeExecute, 'manifest must be saved before the very first create');
  assert.equal(savedBeforeExecute.run, 'fixture-run');
  assert.equal(savedBeforeExecute.prefix, args.name);
  assert.deepEqual(savedBeforeExecute.operations[0], {
    operation: 'create_project', input: { ...args, idempotencyKey: 'stable-fixture-key' }, state: 'pending',
  });
  const saved = JSON.parse(await readFile(tracked.manifestPath, 'utf8'));
  assert.equal(saved.operations[0].state, 'unknown');
  assert.equal(saved.operations[0].input.idempotencyKey, 'stable-fixture-key');
  assert.deepEqual(saved.created, []);
  await tracked.cleanup();
  await assert.rejects(tracked.created('create_project', args, 'project', 'replacement-key'), /reconcil/i);
  assert.equal(calls.length, 1, 'uncertain operations must not be replayed with a fresh key');
});

test('a successful mutation whose manifest persistence fails retains its pending intent and stops cleanup', async t => {
  let calls = 0;
  let unavailableDirectory;
  const tracked = await fixture(t, async () => {
    calls++;
    unavailableDirectory = `${dirname(tracked.manifestPath)}-unavailable`;
    await rename(dirname(tracked.manifestPath), unavailableDirectory);
    t.after(() => rm(unavailableDirectory, { recursive: true, force: true }));
    return { ok: true, outcome: 'succeeded', item: { type: 'tag', id: 'created-tag' } };
  });
  await assert.rejects(tracked.created('create_tag', { name: tracked.manifest.prefix }, 'tag'), { code: 'ENOENT' });
  await rename(unavailableDirectory, dirname(tracked.manifestPath));
  const saved = JSON.parse(await readFile(tracked.manifestPath, 'utf8'));
  assert.equal(saved.operations[0].state, 'pending');
  assert.equal(saved.operations[0].operation, 'create_tag');
  assert.ok(saved.operations[0].input.idempotencyKey);
  assert.equal((await tracked.cleanup()).reconciliationRequired, true);
  assert.equal(calls, 1);
});

test('an uncertain deletion is recorded and never retried by cleanup', async t => {
  let calls = 0;
  const tracked = await fixture(t, async operation => {
    calls++;
    return operation === 'create_tag'
      ? { ok: true, outcome: 'succeeded', item: { type: 'tag', id: 'created-tag' } }
      : { ok: false, outcome: 'unknown', errorCode: 'OUTCOME_UNKNOWN' };
  });
  const tagId = await tracked.created('create_tag', { name: tracked.manifest.prefix }, 'tag');
  await assert.rejects(tracked.remove('tag', tagId));
  assert.equal((await tracked.cleanup()).reconciliationRequired, true);
  const saved = JSON.parse(await readFile(tracked.manifestPath, 'utf8'));
  assert.equal(saved.operations[1].operation, 'delete_item');
  assert.equal(saved.operations[1].state, 'unknown');
  assert.equal(saved.created[0].deleted, false);
  assert.equal(calls, 2);
});

test('uncertain child creation prevents cascading cleanup of the known project', async t => {
  const calls = [];
  const tracked = await fixture(t, async (operation, input) => {
    calls.push({ operation, input });
    if (operation === 'create_project') return { ok: true, outcome: 'succeeded', item: { type: 'project', id: 'known-project' } };
    throw new Error('Timeout after task may have been created');
  });
  const projectId = await tracked.created('create_project', { name: tracked.manifest.prefix }, 'project');
  await assert.rejects(tracked.created('create_task', { name: `${tracked.manifest.prefix} task`, projectId }, 'task'));
  await tracked.cleanup();
  assert.equal(calls.length, 2, 'deleting the project could destroy the uncertain task');
  const saved = JSON.parse(await readFile(tracked.manifestPath, 'utf8'));
  assert.equal(saved.operations[1].state, 'unknown');
  assert.equal(saved.created[0].deleted, false);
});

test('successful fixture cleanup deletes each recorded item once and saves deletion intents first', async t => {
  const calls = [];
  const tracked = await fixture(t, async (operation, input) => {
    calls.push({ operation, input });
    const saved = JSON.parse(await readFile(tracked.manifestPath, 'utf8'));
    assert.deepEqual(saved.operations.at(-1), { operation, input, state: 'pending' });
    return operation === 'delete_item'
      ? { ok: true, outcome: 'succeeded', item: { type: input.type, id: input.itemId, deleted: true } }
      : { ok: true, outcome: 'succeeded', item: { type: 'tag', id: 'created-tag' } };
  });
  await tracked.created('create_tag', { name: tracked.manifest.prefix }, 'tag');
  await tracked.cleanup();
  await tracked.cleanup();
  assert.equal(calls.length, 2);
  const saved = JSON.parse(await readFile(tracked.manifestPath, 'utf8'));
  assert.equal(saved.created[0].deleted, true);
  assert.deepEqual(saved.operations.map(operation => operation.state), ['succeeded', 'succeeded']);
});

test('cleanup continues after a recorded child is definitively absent following parent deletion', async t => {
  const remaining = new Set();
  const deleted = [];
  const tracked = await fixture(t, async (operation, input) => {
    if (operation.startsWith('create_')) {
      remaining.add(input.name);
      return {ok:true,outcome:'succeeded',item:{type:operation.slice(7),id:input.name}};
    }
    if (!remaining.has(input.itemId)) return {ok:false,outcome:'not_applied',errorCode:'NOT_FOUND'};
    remaining.delete(input.itemId);deleted.push(input.itemId);
    if (input.itemId === 'later-parent') remaining.delete('earlier-child');
    return {ok:true,outcome:'succeeded',item:{type:input.type,id:input.itemId,deleted:true}};
  });
  await tracked.created('create_project',{name:'project-placeholder'},'project');
  await tracked.created('create_tag',{name:'tag-placeholder'},'tag');
  await tracked.created('create_task',{name:'earlier-child',projectId:'project-placeholder'},'task');
  await tracked.created('create_task',{name:'later-parent',projectId:'project-placeholder'},'task');
  assert.equal((await tracked.cleanup()).cleanupRequired,false);
  assert.deepEqual([...remaining],[]);
  assert.deepEqual(deleted,['later-parent','tag-placeholder','project-placeholder']);
  const saved=JSON.parse(await readFile(tracked.manifestPath,'utf8'));
  assert.ok(saved.created.every(item=>item.deleted));
  assert.equal(saved.operations.find(op=>op.input.itemId==='earlier-child').state,'not_applied');
});
