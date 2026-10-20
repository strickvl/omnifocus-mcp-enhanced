import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

export async function createWriteFixture({ directory, execute, run = randomUUID() }) {
  if (!isAbsolute(directory) || !/^[a-zA-Z0-9-]{1,128}$/.test(run)) throw new Error('A private absolute fixture directory and safe run ID are required');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.()) {
    throw new Error('Fixture directory must be private and owned by the current user');
  }
  const manifest = { run, prefix: `OmniFocus MCP verification ${run}`, operations: [], created: [], checks: [] };
  const manifestPath = join(directory, `${run}.json`);
  let persistenceUncertain = false;
  const needsReconciliation = () => persistenceUncertain || manifest.operations.some(operation => ['pending', 'unknown'].includes(operation.state));
  async function syncDirectory(path) {
    const handle = await open(await realpath(path), 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async function save(initial = false) {
    const temporary = initial ? manifestPath : join(directory, `.${run}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(manifest, null, 2), 'utf8');
      await handle.sync();
      await handle.close();
      if (!initial) await rename(temporary, manifestPath);
      await syncDirectory(directory);
      if (initial) {
        let parent = dirname(directory);
        for (;;) {
          await syncDirectory(parent);
          if (dirname(parent) === parent) break;
          parent = dirname(parent);
        }
      }
    } catch (error) {
      persistenceUncertain = true;
      throw error;
    } finally {
      await handle?.close();
      if (!initial) await unlink(temporary).catch(() => {});
    }
  }
  await save(true);
  async function mutate(name, args, key = randomUUID(), createdType) {
    if (needsReconciliation()) throw new Error(`Fixture requires manual reconciliation: ${manifestPath}`);
    const operation = { operation: name, input: structuredClone({ ...args, idempotencyKey: key }), state: 'pending' };
    manifest.operations.push(operation);
    await save();
    let result;
    try { result = await execute(name, operation.input); }
    catch (error) {
      operation.state = 'unknown';
      await save();
      throw error;
    }
    operation.state = result.ok ? 'succeeded' : ['not_applied', 'rejected'].includes(result.outcome) ? result.outcome : 'unknown';
    operation.result = result;
    if (result.ok && createdType) manifest.created.push({ type: createdType, id: result.item.id, deleted: false });
    const deletedItem = name === 'delete_item' ? manifest.created.find(item => item.type === args.type && item.id === args.itemId) : undefined;
    const confirmedAbsent = deletedItem && !result.ok && result.outcome === 'not_applied' && result.errorCode === 'NOT_FOUND';
    if (deletedItem && (result.ok || confirmedAbsent)) deletedItem.deleted = true;
    await save();
    if (!result.ok && !confirmedAbsent) throw new Error(`${name}: ${JSON.stringify(result)}`);
    return result;
  }
  async function created(name, args, type, key) {
    const result = await mutate(name, args, key, type);
    return result.item.id;
  }
  async function remove(type, id) {
    const item = manifest.created.find(item => item.type === type && item.id === id);
    if (!item) throw new Error('Cleanup requires a recorded created item');
    if (item.deleted) return;
    await mutate('delete_item', { type, itemId: id, confirmId: id, includeChildren: true });
  }
  async function cleanup() {
    if (needsReconciliation()) return { cleanupRequired: true, reconciliationRequired: true, manifest: manifestPath };
    for (const item of [...manifest.created].reverse()) {
      if (!item.deleted) await remove(item.type, item.id);
    }
    return { cleanupRequired: false, manifest: manifestPath };
  }
  return { manifest, manifestPath, save, mutate, created, remove, cleanup };
}
