import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { runOsascript, serialize, type AutomationRunner } from "./automation.js";
import { buildMutationScript, mutationResultSchema, mutationSchemas, type MutationName } from "./writeOperations.js";

const MAX_RESULT_BYTES = 16_384;
const MAX_RECORD_BYTES = MAX_RESULT_BYTES + 4096;
const MAX_RECORDS = 50_000;
const keySchema = z.string().min(1).max(128);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const operationSchema = z.custom<MutationName>(value => typeof value === "string" && Object.hasOwn(mutationSchemas, value));
const commonRecord = {
  version: z.literal(1), keyHash: hashSchema, requestHash: hashSchema,
  operation: operationSchema, checksum: hashSchema,
};
const pendingSchema = z.object({ ...commonRecord, state: z.literal("pending") }).strict();
const finishedSchema = z.object({ ...commonRecord, state: z.literal("finished"), result: mutationResultSchema }).strict()
  .refine(record => record.result.ok || record.result.outcome === "not_applied");
const recordSchema = z.union([pendingSchema, finishedSchema]);
type JournalRecord = z.infer<typeof recordSchema>;
type RecordPayload = JournalRecord extends infer R ? R extends JournalRecord ? Omit<R, "checksum"> : never : never;
type MutationResult = z.infer<typeof mutationResultSchema>;
type MutationArgs = z.infer<(typeof mutationSchemas)[MutationName]>;
type RejectionCode = "IDEMPOTENCY_CONFLICT" | "LEDGER_UNAVAILABLE" | "LEDGER_FULL";
export type WriteOutcome =
  | (Extract<MutationResult, { ok: true }> & { outcome: "succeeded"; idempotencyKey: string })
  | { ok: false; outcome: "not_applied"; idempotencyKey: string; errorCode: Extract<MutationResult, { ok: false }>["errorCode"] }
  | { ok: false; outcome: "unknown"; idempotencyKey: string; errorCode: "OUTCOME_UNKNOWN" }
  | { ok: false; outcome: "rejected"; idempotencyKey: string; errorCode: RejectionCode };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function unknownOutcome(idempotencyKey: string): WriteOutcome {
  return { ok: false, outcome: "unknown", idempotencyKey, errorCode: "OUTCOME_UNKNOWN" };
}
function rejected(idempotencyKey: string, errorCode: RejectionCode): WriteOutcome {
  return { ok: false, outcome: "rejected", idempotencyKey, errorCode };
}
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
function seal(record: RecordPayload): JournalRecord {
  return recordSchema.parse({ ...record, checksum: hash(canonical(record)) });
}

function validateResult(operation: MutationName, args: MutationArgs, result: MutationResult): void {
  if (!result.ok) return;
  const item = result.item;
  if (operation === "delete_item") {
    if (!("deleted" in item) || !("type" in args) || !("itemId" in args) || item.type !== args.type || item.id !== args.itemId) {
      throw new Error("Unexpected write result.");
    }
    return;
  }
  if ("deleted" in item || item.type !== operation.split("_")[1]) throw new Error("Unexpected write result.");
  if (operation.startsWith("update_")) {
    const originalId = "taskId" in args ? args.taskId : "projectId" in args ? args.projectId : "tagId" in args ? args.tagId : undefined;
    if (item.id !== originalId && !(operation === "update_task" && item.type === "task"
      && "allowRepeatingCompletion" in args && args.allowRepeatingCompletion && "completed" in args && args.completed
      && item.completed && item.sourceTaskId === originalId)) throw new Error("Unexpected write result.");
  }
}

export function createWriteExecutor(options: {
  directory: string; runner?: AutomationRunner;
  io?: Partial<Pick<typeof import("node:fs/promises"), "open" | "rename">>;
}) {
  if (!isAbsolute(options.directory) || options.directory.length > 1024) throw new Error("A valid absolute write ledger directory is required.");
  const directory = resolve(options.directory);
  const runner = options.runner ?? runOsascript;
  const ledgerOpen = options.io?.open ?? open;
  const ledgerRename = options.io?.rename ?? rename;
  let initialized = false;

  async function checkDirectory(create: boolean): Promise<void> {
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.()) {
      throw new Error("Write ledger directory is unavailable.");
    }
    if (create && !initialized) {
      // A newly created ledger must survive loss of any newly created parent directory.
      let current = directory;
      for (;;) {
        const handle = await ledgerOpen(await realpath(current), constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await handle.sync(); }
        finally { await handle.close(); }
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
      initialized = true;
    }
  }

  async function syncDirectory(): Promise<void> {
    const handle = await ledgerOpen(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await handle.sync(); }
    finally { await handle.close(); }
  }

  async function load(keyHash: string): Promise<JournalRecord | null> {
    let handle;
    try { handle = await ledgerOpen(join(directory, `${keyHash}.json`), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (hasCode(error, "ENOENT")) return null; throw error; }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.() || info.size > MAX_RECORD_BYTES) {
        throw new Error("Write ledger record is unavailable.");
      }
      const record = recordSchema.parse(JSON.parse(await handle.readFile("utf8")));
      const { checksum, ...payload } = record;
      if (record.keyHash !== keyHash || checksum !== hash(canonical(payload))) throw new Error("Write ledger record is unavailable.");
      if (record.state === "finished" && Buffer.byteLength(JSON.stringify(record.result)) > MAX_RESULT_BYTES) throw new Error("Write ledger record is unavailable.");
      return record;
    } finally { await handle.close(); }
  }

  async function claim(record: JournalRecord): Promise<boolean> {
    let handle;
    try {
      handle = await ledgerOpen(join(directory, `${record.keyHash}.json`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) { if (hasCode(error, "EEXIST")) return false; throw error; }
    try {
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await syncDirectory();
    return true;
  }

  async function finish(record: JournalRecord): Promise<void> {
    const temporary = join(directory, `.${record.keyHash}.${randomUUID()}.tmp`);
    const handle = await ledgerOpen(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.sync();
      await handle.close();
      await checkDirectory(false);
      await ledgerRename(temporary, join(directory, `${record.keyHash}.json`));
      await syncDirectory();
    } finally {
      await handle.close();
      await unlink(temporary).catch(() => {});
    }
  }

  function replay(record: JournalRecord, requestHash: string, idempotencyKey: string): WriteOutcome {
    if (record.requestHash !== requestHash) return rejected(idempotencyKey, "IDEMPOTENCY_CONFLICT");
    if (record.state === "pending") return unknownOutcome(idempotencyKey);
    if (record.result.ok) return { ...record.result, outcome: "succeeded", idempotencyKey };
    return { ok: false, outcome: "not_applied", idempotencyKey, errorCode: record.result.errorCode };
  }

  function execute(name: MutationName, input: unknown): Promise<WriteOutcome> {
    const operation = operationSchema.parse(name);
    const args = mutationSchemas[operation].parse(input);
    const { idempotencyKey, ...mutationArgs } = args;
    const key = keySchema.parse(idempotencyKey);
    const keyHash = hash(key);
    const requestHash = hash(canonical({ operation, args: mutationArgs }));
    const script = buildMutationScript(operation, args);

    return serialize(async () => {
      try {
        await checkDirectory(true);
        const existing = await load(keyHash);
        if (existing) return replay(existing, requestHash, key);
        if ((await readdir(directory)).length >= MAX_RECORDS) return rejected(key, "LEDGER_FULL");
        const pending = seal({ version: 1, state: "pending", keyHash, requestHash, operation });
        if (!await claim(pending)) {
          const contender = await load(keyHash);
          return contender ? replay(contender, requestHash, key) : rejected(key, "LEDGER_UNAVAILABLE");
        }
      } catch { return rejected(key, "LEDGER_UNAVAILABLE"); }

      try {
        const output = await runner(script);
        if (Buffer.byteLength(output, "utf8") > MAX_RESULT_BYTES) return unknownOutcome(key);
        const result = mutationResultSchema.parse(JSON.parse(output));
        validateResult(operation, args, result);
        if (!result.ok && result.outcome === "unknown") return unknownOutcome(key);
        const record = seal({ version: 1, state: "finished", keyHash, requestHash, operation, result });
        await finish(record);
        return replay(record, requestHash, key);
      } catch { return unknownOutcome(key); }
    });
  }

  async function status(input: unknown) {
    const idempotencyKey = keySchema.parse(input);
    try {
      try { await checkDirectory(false); }
      catch (error) {
        if (hasCode(error, "ENOENT")) return { ok: true, outcome: "not_found", idempotencyKey } as const;
        throw error;
      }
      const record = await load(hash(idempotencyKey));
      if (!record) return { ok: true, outcome: "not_found", idempotencyKey } as const;
      return {
        ok: true, outcome: record.state === "pending" ? "unknown" : record.result.ok ? "succeeded" : "not_applied", idempotencyKey,
        operation: record.operation, requestHash: record.requestHash,
      } as const;
    } catch { return rejected(idempotencyKey, "LEDGER_UNAVAILABLE"); }
  }

  return { execute, status };
}
