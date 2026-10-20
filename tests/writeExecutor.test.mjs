import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWriteExecutor } from "../dist/remote/writeExecutor.js";
import { queryTasks } from "../dist/remote/automation.js";

const goodResult = { ok: true, item: { type: "tag", id: "tag-1", name: "Private task name", nameTruncated: false, parentTagId: null, status: "active" } };
const args = { idempotencyKey: "test-key-123", name: "Private task name" };
const keyHash = key => createHash("sha256").update(key).digest("hex");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "omnifocus-ledger-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory: join(root, "ledger") };
}
function gate() {
  let release;
  return { promise: new Promise(resolve => { release = resolve; }), release: () => release() };
}

test("durable same-key replay returns the exact result and changed arguments conflict", async t => {
  const { directory } = await fixture(t);
  let calls = 0;
  const runner = async () => { calls++; return JSON.stringify(goodResult); };
  const executor = createWriteExecutor({ directory, runner });
  const first = await executor.execute("create_tag", args);
  assert.deepEqual(first, { ...goodResult, outcome: "succeeded", idempotencyKey: args.idempotencyKey });
  assert.deepEqual(await executor.execute("create_tag", { name: args.name, idempotencyKey: args.idempotencyKey }), first);
  const restarted = createWriteExecutor({ directory, runner });
  assert.deepEqual(await restarted.execute("create_tag", args), first);
  assert.equal((await restarted.execute("create_tag", { ...args, name: "Different" })).errorCode, "IDEMPOTENCY_CONFLICT");
  assert.equal((await restarted.execute("create_project", args)).errorCode, "IDEMPOTENCY_CONFLICT");
  assert.equal(calls, 1);
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  const [filename] = await readdir(directory);
  assert.equal(filename, `${keyHash(args.idempotencyKey)}.json`);
  assert.equal((await lstat(join(directory, filename))).mode & 0o777, 0o600);
  const raw = await readFile(join(directory, filename), "utf8");
  assert.equal(raw.includes(args.idempotencyKey), false);
  assert.equal(raw.includes('"args"'), false);
  const status = await executor.status(args.idempotencyKey);
  assert.equal(status.outcome, "succeeded");
  assert.equal(status.requestHash.length, 64);
  assert.equal(JSON.stringify(status).includes(args.name), false);
  assert.equal("item" in status, false);
});

test("validation happens before queueing or claiming a key", async t => {
  const { directory } = await fixture(t);
  const blocked = gate();
  const read = queryTasks({}, { runner: async () => { await blocked.promise; return '{"tasks":[],"hasMore":false}'; } });
  const executor = createWriteExecutor({ directory, runner: async () => { throw new Error("must not execute"); } });
  try {
    assert.throws(() => executor.execute("create_tag", { ...args, arbitraryScript: "private" }));
    assert.throws(() => executor.execute("create_tag", { ...args, idempotencyKey: "short" }));
    assert.throws(() => executor.execute("delete_item", { idempotencyKey: args.idempotencyKey, type: "task", itemId: "one", confirmId: "two" }));
    await assert.rejects(lstat(directory), { code: "ENOENT" });
  } finally { blocked.release(); await read; }
});

test("runner timeout and unknown mutation results keep a permanent pending claim across restart", async t => {
  for (const run of [
    async () => { throw new Error("timeout containing private notes and script"); },
    async () => JSON.stringify({ ok: false, outcome: "unknown", errorCode: "WRITE_FAILED" }),
  ]) {
    const { directory } = await fixture(t);
    const executor = createWriteExecutor({ directory, runner: run });
    const expected = { ok: false, outcome: "unknown", idempotencyKey: args.idempotencyKey, errorCode: "OUTCOME_UNKNOWN" };
    assert.deepEqual(await executor.execute("create_tag", args), expected);
    let calls = 0;
    const restarted = createWriteExecutor({ directory, runner: async () => { calls++; return JSON.stringify(goodResult); } });
    assert.deepEqual(await restarted.execute("create_tag", args), expected);
    assert.equal(calls, 0);
    assert.equal((await restarted.status(args.idempotencyKey)).outcome, "unknown");
    assert.equal((await restarted.execute("create_tag", { ...args, name: "changed" })).errorCode, "IDEMPOTENCY_CONFLICT");
  }
});

test("concurrent executors share one claim and never overlap reads with writes", async t => {
  const { directory } = await fixture(t);
  const blocked = gate();
  const started = gate();
  let calls = 0;
  let readCalls = 0;
  let active = 0;
  let maxActive = 0;
  const enter = () => { active++; maxActive = Math.max(maxActive, active); };
  const runner = async () => {
    calls++; enter(); started.release(); await blocked.promise; active--;
    return JSON.stringify(goodResult);
  };
  const one = createWriteExecutor({ directory, runner });
  const two = createWriteExecutor({ directory, runner });
  const first = one.execute("create_tag", args);
  await started.promise;
  const second = two.execute("create_tag", args);
  const read = queryTasks({}, { runner: async () => { readCalls++; enter(); active--; return '{"tasks":[],"hasMore":false}'; } });
  assert.equal(readCalls, 0);
  blocked.release();
  assert.deepEqual(await first, await second);
  await read;
  assert.equal(calls, 1);
  assert.equal(maxActive, 1);
});

test("a killed process leaves a durable pending claim which another process cannot execute", async t => {
  const { directory } = await fixture(t);
  const moduleUrl = new URL("../dist/remote/writeExecutor.js", import.meta.url).href;
  const code = `import {createWriteExecutor} from ${JSON.stringify(moduleUrl)};
    createWriteExecutor({directory:process.argv[1],runner:async()=>{
      process.stdout.write("claimed\\n"); await new Promise(()=>{setInterval(()=>{},1000)});
    }}).execute("create_tag",${JSON.stringify(args)});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, directory], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  const closed = once(child, "close");
  const ready = await Promise.race([
    once(child.stdout, "data").then(([data]) => data.toString()),
    closed.then(() => { throw new Error("Claim process exited early"); }),
  ]);
  assert.match(ready, /claimed/);
  let calls = 0;
  const executor = createWriteExecutor({ directory, runner: async () => { calls++; return JSON.stringify(goodResult); } });
  assert.equal((await executor.execute("create_tag", args)).outcome, "unknown");
  child.kill("SIGKILL");
  await closed;
  assert.equal((await executor.execute("create_tag", args)).outcome, "unknown");
  assert.equal(calls, 0);
});

test("known not-applied results are replayed without executing again", async t => {
  const { directory } = await fixture(t);
  let calls = 0;
  const result = { ok: false, outcome: "not_applied", errorCode: "NOT_FOUND" };
  const executor = createWriteExecutor({ directory, runner: async () => { calls++; return JSON.stringify(result); } });
  const expected = { ...result, idempotencyKey: args.idempotencyKey };
  assert.deepEqual(await executor.execute("create_tag", args), expected);
  assert.deepEqual(await executor.execute("create_tag", args), expected);
  assert.equal((await executor.status(args.idempotencyKey)).outcome, "not_applied");
  assert.equal(calls, 1);
});

test("malformed, oversized, unexpected-type and wrong-target responses fail closed", async t => {
  for (const output of [
    "private script error", "x".repeat(16385),
    JSON.stringify({ ...goodResult, privateNote: "not allowed" }),
    JSON.stringify({ ok: true, item: { ...goodResult.item, type: "task" } }),
    JSON.stringify({ ok: true, item: { type: "tag", id: "tag-1", deleted: true } }),
  ]) {
    const { directory } = await fixture(t);
    let calls = 0;
    const executor = createWriteExecutor({ directory, runner: async () => { calls++; return output; } });
    const first = await executor.execute("create_tag", args);
    assert.equal(first.errorCode, "OUTCOME_UNKNOWN");
    assert.equal((await executor.execute("create_tag", args)).errorCode, "OUTCOME_UNKNOWN");
    assert.equal(calls, 1);
  }
  const { directory } = await fixture(t);
  const executor = createWriteExecutor({ directory, runner: async () => JSON.stringify(goodResult) });
  assert.equal((await executor.execute("update_tag", { ...args, tagId: "different-tag" })).errorCode, "OUTCOME_UNKNOWN");
});

test("insecure directories, symlinks, corrupt records and altered checksums cannot reenable execution", async t => {
  const { root, directory } = await fixture(t);
  let calls = 0;
  const runner = async () => { calls++; return JSON.stringify(goodResult); };
  await mkdir(directory, { mode: 0o755 });
  assert.equal((await createWriteExecutor({ directory, runner }).execute("create_tag", args)).errorCode, "LEDGER_UNAVAILABLE");
  await chmod(directory, 0o700);
  const executor = createWriteExecutor({ directory, runner });
  assert.equal((await executor.execute("create_tag", args)).outcome, "succeeded");
  const filename = join(directory, `${keyHash(args.idempotencyKey)}.json`);
  const record = JSON.parse(await readFile(filename, "utf8"));
  record.result.item.name = "Altered value";
  await writeFile(filename, JSON.stringify(record));
  assert.equal((await executor.execute("create_tag", args)).errorCode, "LEDGER_UNAVAILABLE");
  assert.equal((await executor.status(args.idempotencyKey)).errorCode, "LEDGER_UNAVAILABLE");
  await writeFile(filename, "{");
  assert.equal((await executor.execute("create_tag", args)).errorCode, "LEDGER_UNAVAILABLE");
  await rm(filename);
  const outside = join(root, "outside.json");
  await writeFile(outside, "{}", { mode: 0o600 });
  await symlink(outside, filename);
  assert.equal((await executor.execute("create_tag", args)).errorCode, "LEDGER_UNAVAILABLE");
  const linkedDirectory = join(root, "linked-ledger");
  await symlink(directory, linkedDirectory);
  assert.equal((await createWriteExecutor({ directory: linkedDirectory, runner }).execute("create_tag", args)).errorCode, "LEDGER_UNAVAILABLE");
  assert.equal(calls, 1);
});

test("status is read-only for an absent directory", async t => {
  const { directory } = await fixture(t);
  const executor = createWriteExecutor({ directory });
  assert.deepEqual(await executor.status(args.idempotencyKey), { ok: true, outcome: "not_found", idempotencyKey: args.idempotencyKey });
  await assert.rejects(lstat(directory), { code: "ENOENT" });
});
