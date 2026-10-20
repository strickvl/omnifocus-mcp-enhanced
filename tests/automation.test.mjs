import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildAutomationScript, getTask, MAX_QUERY_JSON_CHARACTERS, queryTasks, runScriptProcess } from "../dist/remote/automation.js";
import { createReadOnlyServer } from "../dist/remote/readOnlyServer.js";

const Status = Object.fromEntries(["Available", "Blocked", "Completed", "Dropped", "DueSoon", "Next", "Overdue"].map(name => [name, name]));
function task(id, extra = {}) {
  return {
    id: { primaryKey: id }, name: `Task ${id}`, note: "private note", taskStatus: Status.Available,
    flagged: false, inInbox: true, tags: [], containingProject: null,
    dueDate: null, deferDate: null, completionDate: null, ...extra,
  };
}
function runnerFor(tasks, onRun = () => {}) {
  return async script => {
    onRun();
    const context = {
      Application(name) {
        assert.equal(name, "OmniFocus");
        return { evaluateJavascript: source => vm.runInNewContext(source, { flattenedTasks: tasks, Task: { Status } }) };
      },
    };
    return vm.runInNewContext(`${script}; run();`, context);
  };
}

test("hostile user strings remain data through both JavaScript interpreters", async () => {
  const hostile = '"`); throw new Error("injected"); // ${globalThis.pwned=true}\\\n\u2028\u2029';
  const runner = runnerFor([task("safe", { name: hostile })]);
  const result = await queryTasks({ search: hostile }, { runner });
  assert.equal(result.tasks[0].name, hostile);
  assert.match(buildAutomationScript({ operation: "get", taskId: hostile }), /JSON.parse/);
});

test("query applies every filter and compares date bounds as instants", async () => {
  const project = { id: { primaryKey: "project-1" }, name: "Work" };
  const tags = [{ id: { primaryKey: "tag-1" }, name: "Focus" }];
  const matching = task("match", { name: "Prepare report", flagged: true, tags, containingProject: project, dueDate: new Date("2026-10-20T09:00:00Z") });
  const candidates = [
    task("not-flagged", { ...matching, id: { primaryKey: "not-flagged" }, flagged: false }),
    task("completed", { ...matching, id: { primaryKey: "completed" }, taskStatus: Status.Completed }),
    task("no-tag", { ...matching, id: { primaryKey: "no-tag" }, tags: [] }),
    task("other-project", { ...matching, id: { primaryKey: "other-project" }, containingProject: null }),
    task("other-name", { ...matching, id: { primaryKey: "other-name" }, name: "Other" }),
    task("late", { ...matching, id: { primaryKey: "late" }, dueDate: new Date("2026-10-21T00:00:00Z") }),
    task("no-due", { ...matching, id: { primaryKey: "no-due" }, dueDate: null }),
    matching,
  ];
  const result = await queryTasks({
    source: "flagged", search: "REPORT", tag: "fOcUs", project: "project-1",
    dueFrom: "2026-10-20T11:00:00+02:00", dueTo: "2026-10-20T09:00:00Z",
  }, { runner: runnerFor(candidates) });
  assert.deepEqual(result.tasks.map(value => value.id), ["match"]);
  assert.equal(result.hasMore, false);
  assert.equal("note" in result.tasks[0], false);
  const completed = await queryTasks({ statuses: ["completed"] }, { runner: runnerFor(candidates) });
  assert.deepEqual(completed.tasks.map(value => value.id), ["completed"]);
  const inbox = await queryTasks({ source: "inbox" }, { runner: runnerFor([task("outside", { inInbox: false }), task("inside")]) });
  assert.deepEqual(inbox.tasks.map(value => value.id), ["inside"]);
});

test("query and get bound returned data and signal truncation", async () => {
  const long = task("long", {
    name: "n".repeat(300), note: "s".repeat(3000),
    tags: Array.from({ length: 12 }, (_, i) => ({ id: { primaryKey: `tag${i}` }, name: "t".repeat(150) })),
    containingProject: { id: { primaryKey: "project" }, name: "p".repeat(300) },
  });
  const result = await queryTasks({ limit: 1, includeNotes: true }, { runner: runnerFor([long, task("second")]) });
  assert.equal(result.tasks.length, 1);
  assert.equal(result.hasMore, true);
  const item = result.tasks[0];
  assert.equal(item.name.length, 256);
  assert.equal(item.nameTruncated, true);
  assert.equal(item.note.length, 2000);
  assert.equal(item.noteTruncated, true);
  assert.equal(item.tags.length, 10);
  assert.equal(item.tagsTruncated, true);
  assert.equal(item.tags[0].name.length, 128);
  assert.equal(item.tags[0].nameTruncated, true);
  assert.equal(item.project.name.length, 256);
  assert.equal(item.project.nameTruncated, true);
  assert.equal((await getTask({ taskId: "long" }, { runner: runnerFor([long]) })).task.id, "long");
  assert.equal((await getTask({ taskId: "lon" }, { runner: runnerFor([long]) })).task, null);
});

test("invalid filters reject before starting automation", () => {
  const options = { runner: async () => { throw new Error("should not run"); } };
  for (const input of [
    { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { arbitraryScript: "bad" },
    { dueFrom: "2026-10-20" }, { dueFrom: "2026-10-20T09:00:00" },
    { dueFrom: "2026-10-21T00:00:00Z", dueTo: "2026-10-20T00:00:00Z" },
  ]) assert.throws(() => queryTasks(input, options));
  assert.throws(() => getTask({ taskId: "x".repeat(129) }, options));
  assert.throws(() => getTask({ taskId: "" }, options));
});

test("query caps full serialized JSON, including escaped notes and tags, and returns the largest fitting prefix", async () => {
  for (const characters of ["x", '"\\\n\r\t\u0000', "漢🙂"]) {
    const fill = length => characters.repeat(length).slice(0, length);
    const candidates = Array.from({ length: 100 }, (_, index) => task(String(index), {
      name: fill(256), note: fill(2000),
      tags: Array.from({ length: 10 }, (_, tag) => ({ id: { primaryKey: String(tag) }, name: fill(128) })),
      containingProject: { id: { primaryKey: "project" }, name: fill(256) },
    }));
    const runner = runnerFor(candidates);
    const result = await queryTasks({ limit: 100, includeNotes: true }, { runner });
    assert.ok(result.tasks.length > 0 && result.tasks.length < 100);
    assert.equal(result.hasMore, true);
    assert.ok(JSON.stringify(result).length <= MAX_QUERY_JSON_CHARACTERS);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1024 * 1024);
    const next = await getTask({ taskId: String(result.tasks.length), includeNotes: true }, { runner });
    assert.ok(JSON.stringify({ tasks: [...result.tasks, next.task], hasMore: true }).length > MAX_QUERY_JSON_CHARACTERS);
    const exactlyFitting = await queryTasks({ limit: 100, includeNotes: true }, { runner: runnerFor(candidates.slice(0, result.tasks.length)) });
    assert.equal(exactlyFitting.hasMore, false);
    assert.ok(JSON.stringify(exactlyFitting).length <= MAX_QUERY_JSON_CHARACTERS);
  }
});

test("query result validation rejects an oversized runner response", async () => {
  const item = (await getTask({ taskId: "one", includeNotes: true }, {
    runner: runnerFor([task("one", { note: "n".repeat(2000) })]),
  })).task;
  const output = JSON.stringify({ tasks: Array.from({ length: 100 }, () => item), hasMore: false });
  assert.ok(output.length > MAX_QUERY_JSON_CHARACTERS);
  await assert.rejects(queryTasks({ limit: 100 }, { runner: async () => output }), /OmniFocus read failed/);
});

test("queue is global across server options, serial, bounded, and recovers after failure", async () => {
  let release;
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const runner = async () => {
    calls++;
    active++;
    maxActive = Math.max(maxActive, active);
    await gate;
    active--;
    return '{"tasks":[],"hasMore":false}';
  };
  const jobs = Array.from({ length: 9 }, () => queryTasks({}, { runner }));
  await assert.rejects(queryTasks({}, { runner }), /busy/);
  assert.equal(calls, 1);
  release();
  await Promise.all(jobs);
  assert.equal(calls, 9);
  assert.equal(maxActive, 1);
  await assert.rejects(queryTasks({}, { runner: async () => { throw new Error("private content"); } }), error => !error.message.includes("private content"));
  assert.deepEqual(await queryTasks({}, { runner }), { tasks: [], hasMore: false });
});

test("real child processes time out, bound output, and suppress child diagnostics", async () => {
  await assert.rejects(runScriptProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], "", { timeoutMs: 40 }), /OmniFocus read failed/);
  await assert.rejects(runScriptProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(2048))"], "", { maxOutputBytes: 1024 }), /OmniFocus read failed/);
  await assert.rejects(runScriptProcess(process.execPath, ["-e", "process.stderr.write('private task'); process.exit(1)"], ""), error => !error.message.includes("private task"));
  await assert.rejects(runScriptProcess("/nonexistent-omnifocus-test", [], ""), /OmniFocus read failed/);
  assert.equal(await runScriptProcess(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], "test data"), "test data");
});

test("MCP server exposes exactly two annotated read-only tools without importing legacy registrations", async () => {
  let runnerCalls = 0;
  const server = createReadOnlyServer({ runner: runnerFor([task("one")], () => { runnerCalls++; }) });
  const client = new Client({ name: "read-only-tests", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ["get_task", "query_tasks"]);
    for (const tool of tools) {
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.equal(tool.annotations.destructiveHint, false);
      assert.equal(tool.annotations.openWorldHint, false);
      assert.deepEqual(tool._meta.securitySchemes, [{ type: "oauth2", scopes: [] }]);
    }
    const result = await client.callTool({ name: "get_task", arguments: { taskId: "one" } });
    assert.equal(JSON.parse(result.content[0].text).task.id, "one");
    const queryTool = tools.find(tool => tool.name === "query_tasks");
    assert.equal(queryTool.inputSchema.additionalProperties, false);
    const callsBeforeInvalid = runnerCalls;
    const rejected = await client.callTool({ name: "query_tasks", arguments: { perspectiveID: "perspective-1" } });
    assert.equal(rejected.isError, true);
    assert.equal(runnerCalls, callsBeforeInvalid, "unknown perspectiveID must reject before automation");
    const invalid = await client.callTool({ name: "query_tasks", arguments: { dueFrom: "2026-10-21T00:00:00Z", dueTo: "2026-10-20T00:00:00Z" } });
    assert.equal(invalid.isError, true);
    assert.equal(runnerCalls, callsBeforeInvalid, "reversed dates must reject before automation");
  } finally {
    await client.close();
    await server.close();
  }
});

function perspectiveRuntime(items, options = {}) {
  class OmniTask { static Status = Status; }
  const tasks = items.map(item => Object.assign(new OmniTask(), item));
  const perspective = { identifier: "perspective-1", name: '"`); throw Error("injected"); // ${bad}' };
  const original = { name: "Original perspective" };
  let current = original;
  const changes = [];
  const node = (object, children = []) => ({ object, children, expand() { throw new Error("Nodes must not be expanded"); } });
  const window = {
    get perspective() { return current; },
    set perspective(value) { current = value; changes.push(value); },
    get content() {
      if (options.treeError) throw new Error("Private tree failure");
      assert.equal(current, perspective);
      return { rootNode: { children: options.nodes ? options.nodes(tasks, node) : tasks.map(item => node(item)) } };
    },
  };
  return {
    tasks, original, perspective, changes, current: () => current,
    runner: async script => vm.runInNewContext(`${script}; run();`, {
      Application() {
        return { evaluateJavascript: source => vm.runInNewContext(source, {
          Task: OmniTask, flattenedTasks: tasks, Perspective: { Custom: { all: [perspective] } },
          document: { windows: options.noWindow ? [] : [window] },
        }) };
      },
    }),
  };
}

test("custom perspective query reads tree task population, deduplicates IDs and restores the original perspective", async () => {
  const env = perspectiveRuntime([task("a"), task("b"), task("outside")], {
    nodes: (tasks, node) => [node({ name: "group" }, [node(tasks[1]), node(tasks[0])]), node(tasks[1])],
  });
  const result = await queryTasks({ perspectiveId: "perspective-1" }, { runner: env.runner });
  assert.deepEqual(result.tasks.map(item => item.id), ["b", "a"]);
  assert.equal(result.hasMore, false); assert.equal(env.current(), env.original);
  assert.deepEqual(env.changes, [env.perspective, env.original]);
  const filtered = await queryTasks({ perspectiveId: "perspective-1", search: "Task a" }, { runner: env.runner });
  assert.deepEqual(filtered.tasks.map(item => item.id), ["a"]);
});

test("perspective IDs require exact identifiers and failures never fall back to all tasks", async () => {
  for (const perspectiveId of ["missing", "perspective", '"; throw Error("injected"); //']) {
    const env = perspectiveRuntime([task("outside")]);
    await assert.rejects(queryTasks({ perspectiveId }, { runner: env.runner }), /OmniFocus read failed/);
    assert.deepEqual(env.changes, []); assert.equal(env.current(), env.original);
  }
  const env = perspectiveRuntime([task("outside")], { noWindow: true });
  await assert.rejects(queryTasks({ perspectiveId: "perspective-1" }, { runner: env.runner }), /OmniFocus read failed/);
  assert.deepEqual(env.changes, []);
  assert.throws(() => queryTasks({ perspectiveId: "" }));
  assert.throws(() => queryTasks({ perspectiveId: "x".repeat(129) }));
});

test("perspective queries restore the original window after tree and serialization failures", async () => {
  for (const treeError of [false, true]) {
    const broken = task("bad", { dueDate: { toISOString() { throw new Error("Private date failure"); } } });
    const env = perspectiveRuntime([broken], { treeError });
    await assert.rejects(queryTasks({ perspectiveId: "perspective-1" }, { runner: env.runner }), /OmniFocus read failed/);
    assert.equal(env.current(), env.original); assert.deepEqual(env.changes, [env.perspective, env.original]);
  }
});

test("perspective query enforces existing limit and JSON response budget", async () => {
  const candidates = Array.from({ length: 100 }, (_, index) => task(String(index), {
    name: "n".repeat(256), note: '"\\\n'.repeat(1000),
    tags: Array.from({ length: 10 }, (_, tag) => ({ id: { primaryKey: String(tag) }, name: "t".repeat(128) })),
  }));
  const env = perspectiveRuntime(candidates);
  const limited = await queryTasks({ perspectiveId: "perspective-1", limit: 1 }, { runner: env.runner });
  assert.equal(limited.tasks.length, 1); assert.equal(limited.hasMore, true);
  const result = await queryTasks({ perspectiveId: "perspective-1", limit: 100, includeNotes: true }, { runner: env.runner });
  assert.ok(result.tasks.length > 0 && result.tasks.length < 100); assert.equal(result.hasMore, true);
  assert.ok(JSON.stringify(result).length <= MAX_QUERY_JSON_CHARACTERS); assert.equal(env.current(), env.original);
});

test("get operation bypasses custom perspective access and does not require an open window", async () => {
  const env = perspectiveRuntime([task("one")], { noWindow: true });
  const result = JSON.parse(await env.runner(buildAutomationScript({ operation: "get", taskId: "one", perspectiveId: "missing" })));
  assert.equal(result.task.id, "one"); assert.deepEqual(env.changes, []);
});
