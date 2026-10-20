import { spawn } from "node:child_process";
import { z } from "zod";

const MAX_OUTPUT_BYTES = 1024 * 1024;
export const MAX_QUERY_JSON_CHARACTERS = 100_000;
const ERROR_MESSAGE = "OmniFocus read failed. Check local automation access and try again.";
const statusSchema = z.enum(["available", "blocked", "completed", "dropped", "dueSoon", "next", "overdue", "unknown"]);
const timestamp = z.string().datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)));

export const queryShape = {
  perspectiveId: z.string().min(1).max(128).optional().describe("Exact custom perspective identifier. Reads tasks from the OmniFocus content tree with its current view filters; temporarily switches and restores the first open window without expanding nodes."),
  source: z.enum(["all", "inbox", "flagged"]).default("all"),
  search: z.string().min(1).max(256).optional().describe("Case-insensitive task name substring."),
  tag: z.string().min(1).max(256).optional().describe("Exact tag ID or case-insensitive tag name."),
  project: z.string().min(1).max(256).optional().describe("Exact project ID or case-insensitive project name."),
  statuses: z.array(z.union([statusSchema, z.literal("active")])).min(1).max(9).default(["active"])
    .describe("Active excludes completed and dropped. Explicit statuses are combined with OR."),
  dueFrom: timestamp.optional().describe("Inclusive lower due-date bound, ISO 8601 with Z or a UTC offset."),
  dueTo: timestamp.optional().describe("Inclusive upper due-date bound, ISO 8601 with Z or a UTC offset."),
  limit: z.number().int().min(1).max(100).default(20),
  includeNotes: z.boolean().default(false),
};
export const querySchema = z.object(queryShape).strict().refine(
  args => !args.dueFrom || !args.dueTo || Date.parse(args.dueFrom) <= Date.parse(args.dueTo),
  { message: "dueFrom must be before or equal to dueTo", path: ["dueTo"] },
);
export const getTaskSchema = z.object({
  taskId: z.string().min(1).max(128).describe("Exact OmniFocus task ID; names are not accepted."),
  includeNotes: z.boolean().default(false),
}).strict();

const namedItemSchema = z.object({ id: z.string().max(128), name: z.string().max(128), nameTruncated: z.boolean() }).strict();
const taskSchema = z.object({
  id: z.string().max(128), name: z.string().max(256), nameTruncated: z.boolean(),
  status: statusSchema, flagged: z.boolean(), inInbox: z.boolean(),
  dueDate: timestamp.nullable(), deferDate: timestamp.nullable(), completionDate: timestamp.nullable(),
  project: z.object({ id: z.string().max(128), name: z.string().max(256), nameTruncated: z.boolean() }).strict().nullable(),
  tags: z.array(namedItemSchema).max(10), tagsTruncated: z.boolean(),
  note: z.string().max(2000).optional(), noteTruncated: z.boolean().optional(), isRepeating: z.boolean().optional(),
}).strict();
const queryResultSchema = z.object({ tasks: z.array(taskSchema).max(100), hasMore: z.boolean() }).strict()
  .refine(result => JSON.stringify(result).length <= MAX_QUERY_JSON_CHARACTERS);
const getResultSchema = z.object({ task: taskSchema.nullable() }).strict();
export type AutomationRunner = (script: string) => Promise<string>;
export interface ReadOnlyOptions { runner?: AutomationRunner }

interface Job { run: () => Promise<unknown>; resolve: (value: unknown) => void; reject: (error: Error) => void }
const pending: Job[] = [];
let running = false;

function execute(job: Job): void {
  running = true;
  void job.run().then(job.resolve, () => job.reject(new Error(ERROR_MESSAGE))).finally(() => {
    const next = pending.shift();
    if (next) execute(next);
    else running = false;
  });
}

export function serialize<T>(run: () => Promise<T>): Promise<T> {
  if (running && pending.length >= 8) return Promise.reject(new Error("OmniFocus is busy. Try again shortly."));
  return new Promise<T>((resolve, reject) => {
    const job: Job = { run, resolve: value => resolve(value as T), reject };
    if (running) pending.push(job);
    else execute(job);
  });
}

/** Resolves only after close, including when a timeout or output limit kills the child. */
export function runScriptProcess(
  command: string,
  args: string[],
  script: string,
  options: { timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], shell: false });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    const fail = () => { failed = true; child.kill("SIGKILL"); };
    const timer = setTimeout(fail, options.timeoutMs ?? 20_000);
    const collect = (chunk: Buffer, stdout: boolean) => {
      bytes += chunk.length;
      if (bytes > (options.maxOutputBytes ?? MAX_OUTPUT_BYTES)) fail();
      else if (stdout && !failed) chunks.push(chunk);
    };
    child.stdout.on("data", chunk => collect(chunk, true));
    child.stderr.on("data", chunk => collect(chunk, false));
    child.on("error", () => { failed = true; });
    child.stdin.on("error", fail);
    child.on("close", code => {
      clearTimeout(timer);
      if (failed || code !== 0) reject(new Error(ERROR_MESSAGE));
      else resolve(Buffer.concat(chunks).toString("utf8").trim());
    });
    child.stdin.end(script);
  });
}

export const runOsascript: AutomationRunner = script =>
  runScriptProcess("/usr/bin/osascript", ["-l", "JavaScript", "-"], script);

const OMNI_BODY = String.raw`
  function text(value, max) {
    const full = String(value || "");
    return { value: full.slice(0, max), truncated: full.length > max };
  }
  function date(value) { return value ? value.toISOString() : null; }
  function status(task) {
    const statuses = [
      [Task.Status.Available, "available"], [Task.Status.Blocked, "blocked"],
      [Task.Status.Completed, "completed"], [Task.Status.Dropped, "dropped"],
      [Task.Status.DueSoon, "dueSoon"], [Task.Status.Next, "next"], [Task.Status.Overdue, "overdue"]
    ];
    const found = statuses.find(entry => entry[0] === task.taskStatus);
    return found ? found[1] : "unknown";
  }
  function serializeTask(task) {
    const name = text(task.name, 256);
    const project = task.containingProject;
    const projectName = project ? text(project.name, 256) : null;
    const result = {
      id: String(task.id.primaryKey), name: name.value, nameTruncated: name.truncated,
      status: status(task), flagged: !!task.flagged, inInbox: !!task.inInbox, isRepeating: !!task.repetitionRule,
      dueDate: date(task.dueDate), deferDate: date(task.deferDate), completionDate: date(task.completionDate),
      project: project ? { id: String(project.id.primaryKey), name: projectName.value, nameTruncated: projectName.truncated } : null,
      tags: task.tags.slice(0, 10).map(tag => {
        const name = text(tag.name, 128);
        return { id: String(tag.id.primaryKey), name: name.value, nameTruncated: name.truncated };
      }),
      tagsTruncated: task.tags.length > 10
    };
    if (args.includeNotes) {
      const note = text(task.note, 2000);
      result.note = note.value;
      result.noteTruncated = note.truncated;
    }
    return result;
  }
  function matchesItem(item, value) {
    return item && (String(item.id.primaryKey) === value || item.name.toLowerCase() === value.toLowerCase());
  }
  if (args.operation === "get") {
    const task = flattenedTasks.find(task => String(task.id.primaryKey) === args.taskId);
    return JSON.stringify({ task: task ? serializeTask(task) : null });
  }
  let perspectiveWindow = null;
  let originalPerspective;
  let requestedPerspective;
  if (args.perspectiveId !== undefined) {
    requestedPerspective = Perspective.Custom.all.find(item => String(item.identifier) === args.perspectiveId);
    if (!requestedPerspective) throw new Error("Custom perspective not found.");
    if (!document.windows.length) throw new Error("Custom perspective queries require an open OmniFocus window.");
    perspectiveWindow = document.windows[0];
    originalPerspective = perspectiveWindow.perspective;
  }
  try {
    let candidates = flattenedTasks;
    if (perspectiveWindow) {
      perspectiveWindow.perspective = requestedPerspective;
      const root = perspectiveWindow.content.rootNode;
      if (!root) throw new Error("Custom perspective content tree unavailable.");
      candidates = [];
      const seen = new Set();
      const nodes = root.children.slice().reverse();
      while (nodes.length) {
        const node = nodes.pop();
        if (node.object instanceof Task) {
          const id = String(node.object.id.primaryKey);
          if (!seen.has(id)) { seen.add(id); candidates.push(node.object); }
        }
        const children = node.children;
        for (let index = children.length - 1; index >= 0; index--) nodes.push(children[index]);
      }
    }
    const tasks = [];
    let hasMore = false;
    let resultLength = JSON.stringify({ tasks: [], hasMore: false }).length;
    for (const task of candidates) {
      if (args.source === "inbox" && !task.inInbox) continue;
      if (args.source === "flagged" && !task.flagged) continue;
      const taskStatus = status(task);
      if (!args.statuses.some(value => value === taskStatus || (value === "active" && taskStatus !== "completed" && taskStatus !== "dropped"))) continue;
      if (args.search && !task.name.toLowerCase().includes(args.search.toLowerCase())) continue;
      if (args.tag && !task.tags.some(tag => matchesItem(tag, args.tag))) continue;
      if (args.project && !matchesItem(task.containingProject, args.project)) continue;
      if (args.dueFrom && (!task.dueDate || task.dueDate.getTime() < Date.parse(args.dueFrom))) continue;
      if (args.dueTo && (!task.dueDate || task.dueDate.getTime() > Date.parse(args.dueTo))) continue;
      if (tasks.length === args.limit) { hasMore = true; break; }
      const serializedTask = serializeTask(task);
      const addedLength = JSON.stringify(serializedTask).length + (tasks.length ? 1 : 0);
      if (resultLength + addedLength > ${MAX_QUERY_JSON_CHARACTERS}) { hasMore = true; break; }
      resultLength += addedLength;
      tasks.push(serializedTask);
    }
    return JSON.stringify({ tasks, hasMore });
  } finally {
    if (perspectiveWindow) perspectiveWindow.perspective = originalPerspective;
  }
`;

function literal(value: unknown): string {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** User fields are JSON data in OmniJS, which is itself a JSON string in JXA. */
export function buildAutomationScript(request: Record<string, unknown>): string {
  const omniScript = `(() => { const args = JSON.parse(${literal(JSON.stringify(request))}); ${OMNI_BODY} })()`;
  return `function run() { return Application("OmniFocus").evaluateJavascript(${literal(omniScript)}); }`;
}

async function read<T>(request: Record<string, unknown>, schema: z.ZodType<T>, options: ReadOnlyOptions): Promise<T> {
  return serialize(async () => {
    const output = await (options.runner ?? runOsascript)(buildAutomationScript(request));
    if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) throw new Error(ERROR_MESSAGE);
    return schema.parse(JSON.parse(output));
  });
}

export function queryTasks(input: unknown, options: ReadOnlyOptions = {}) {
  const args = querySchema.parse(input);
  return read({ ...args, operation: "query" }, queryResultSchema, options);
}

export function getTask(input: unknown, options: ReadOnlyOptions = {}) {
  const args = getTaskSchema.parse(input);
  return read({ ...args, operation: "get" }, getResultSchema, options);
}
