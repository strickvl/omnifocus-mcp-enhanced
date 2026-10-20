import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildMutationScript, mutationSchemas, mutationResultSchema } from "../dist/remote/writeOperations.js";

const key = { idempotencyKey: "test-key-123" };
function runtime() {
  const state = { tasks: [], projects: [], tags: [], folders: [], changes: 0, failAddTags: false };
  let next = 0;
  const status = { Active: "active", OnHold: "onHold", Done: "done", Dropped: "dropped" };
  const inbox = { ending: { kind: "inbox" } }, library = { ending: { kind: "library" } }, tags = { ending: { kind: "tags" } };
  function tracked(object) {
    return new Proxy(object, { set(target, field, value) { state.changes++; target[field] = value; return true; } });
  }
  function placeTask(item, destination) {
    item.parent = destination?.kind === "project" ? destination.task : destination?.kind === "task" ? destination : null;
    item.containingProject = destination?.kind === "project" ? destination : item.parent?.containingProject || null;
    item.inInbox = !item.parent;
  }
  class Task {
    constructor(name, destination) {
      state.changes++;
      const item = tracked({ kind: "task", id: { primaryKey: `task-${++next}` }, name, note: "", flagged: false,
        completed: false, completedByChildren: false, dueDate: null, deferDate: null, estimatedMinutes: null, parent: null,
        project: null, containingProject: null, inInbox: true, tags: [], repetitionRule: null,
        get tasks() { return state.tasks.filter(task => task.parent === item); },
        clearTags() { this.tags = []; },
        addTags(values) { if (state.failAddTags) throw new Error("private detail"); this.tags = [...values]; },
        markComplete() {
          if (this.repetitionRule) {
            const clone = new Task(this.name);
            clone.completed = true; clone.repetitionRule = this.repetitionRule; return clone;
          }
          this.completed = true;
          if (this.parent?.completedByChildren && this.parent.tasks.every(task => task.completed)) this.parent.markComplete();
          return this;
        },
        markIncomplete() { this.completed = false; },
      });
      placeTask(item, destination);
      state.tasks.push(item); return item;
    }
  }
  class Project {
    static Status = status;
    constructor(name, destination) {
      state.changes++;
      const root = new Task(name);
      const item = tracked({ kind: "project", id: { primaryKey: `project-${++next}` }, name,
        task: root, parentFolder: destination?.kind === "folder" ? destination : null, status: status.Active, sequential: false,
        get tasks() { return root.tasks; },
      });
      root.project = item; root.containingProject = item; root.inInbox = false;
      state.projects.push(item); return item;
    }
  }
  class Tag {
    static Status = status;
    constructor(name, destination) {
      state.changes++;
      const item = tracked({ kind: "tag", id: { primaryKey: `tag-${++next}` }, name, parent: destination?.kind === "tag" ? destination : null,
        status: status.Active, get tags() { return state.tags.filter(tag => tag.parent === item); } });
      state.tags.push(item); return item;
    }
  }
  const context = { flattenedTasks: state.tasks, flattenedProjects: state.projects, flattenedTags: state.tags, flattenedFolders: state.folders,
    Task, Project, Tag, inbox, library, tags,
    moveTasks(items, destination) { items.forEach(item => placeTask(item, destination)); },
    moveSections(items, destination) { items.forEach(item => { item.parentFolder = destination?.kind === "folder" ? destination : null; }); },
    moveTags(items, destination) { items.forEach(item => { item.parent = destination?.kind === "tag" ? destination : null; }); },
    deleteObject(item) {
      state.changes++;
      const items = item.kind === "task" ? state.tasks : item.kind === "project" ? state.projects : state.tags;
      items.splice(items.indexOf(item), 1);
    },
  };
  return { state, Task, Project, Tag,
    run(operation, args) {
      const script = buildMutationScript(operation, { ...key, ...args });
      const result = JSON.parse(vm.runInNewContext(`${script}; run();`, {
        Application(value) { assert.equal(value, "OmniFocus"); return { evaluateJavascript(source) { return vm.runInNewContext(source, context); } }; },
      }));
      mutationResultSchema.parse(result); return result;
    },
  };
}
const pk = item => item.id.primaryKey;
const notApplied = errorCode => ({ ok: false, errorCode, outcome: "not_applied" });

test("names and notes survive hostile content through both JavaScript interpreters", () => {
  const env = runtime();
  const hostile = '"`); throw Error("injected"); // ${globalThis.pwned = true}\\\n\u2028\u2029';
  const result = env.run("create_task", { name: hostile, note: hostile });
  assert.equal(result.ok, true); assert.equal(result.item.name, hostile);
  assert.equal(result.item.noteLength, hostile.length); assert.equal(env.state.tasks[0].note, hostile);
});

test("schemas reject no-ops, ambiguous placement, unbounded values and dates without timezone", () => {
  for (const args of [{ taskId: "t" }, { taskId: "t", allowRepeatingCompletion: true }, { taskId: "t", projectId: "p", parentTaskId: "a" },
    { taskId: "t", name: "" }, { taskId: "t", dueDate: "2026-10-20T09:00:00" }, { taskId: "t", dueDate: "2026-02-30T09:00:00Z" },
    { taskId: "t", estimatedMinutes: -1 }, { taskId: "t", tagIds: ["same", "same"] }, { taskId: "t", arbitraryScript: "x" }]) {
    assert.equal(mutationSchemas.update_task.safeParse({ ...key, ...args }).success, false);
  }
  assert.equal(mutationSchemas.update_project.safeParse({ ...key, projectId: "p" }).success, false);
  assert.equal(mutationSchemas.update_tag.safeParse({ ...key, tagId: "t" }).success, false);
  assert.equal(mutationSchemas.create_task.safeParse({ name: "x" }).success, false);
});

test("all referenced IDs resolve exactly before any creation or property edit", () => {
  const env = runtime(); const item = new env.Task("original"); const tag = new env.Tag("tag");
  for (const [operation, args] of [
    ["create_task", { name: "new", tagIds: [pk(tag), "missing"] }],
    ["create_task", { name: "new", projectId: "missing" }],
    ["update_task", { taskId: pk(item), name: "changed", tagIds: ["missing"] }],
    ["update_task", { taskId: item.name, name: "changed" }],
    ["update_task", { taskId: pk(item), name: "changed", parentTaskId: "missing" }],
    ["create_project", { name: "new", folderId: "missing" }],
    ["create_tag", { name: "new", parentTagId: "missing" }],
  ]) {
    const before = env.state.changes;
    assert.deepEqual(env.run(operation, args), notApplied("NOT_FOUND"));
    assert.equal(env.state.changes, before); assert.equal(item.name, "original");
  }
});

test("task placement moves between a project, task group and inbox and rejects cycles", () => {
  const env = runtime(); const project = new env.Project("p"); const parent = new env.Task("parent", project);
  const child = new env.Task("child", parent);
  for (const args of [{ parentTaskId: pk(child) }, { parentTaskId: pk(parent) }]) {
    const before = env.state.changes;
    assert.deepEqual(env.run("update_task", { taskId: pk(parent), name: "no", ...args }), notApplied("INVALID_OPERATION"));
    assert.equal(env.state.changes, before);
  }
  let result = env.run("update_task", { taskId: pk(child), projectId: pk(project) });
  assert.equal(result.item.projectId, pk(project)); assert.equal(result.item.parentTaskId, null);
  result = env.run("update_task", { taskId: pk(child), projectId: null });
  assert.equal(result.item.inInbox, true); assert.equal(result.item.projectId, null);
  result = env.run("update_task", { taskId: pk(child), parentTaskId: pk(parent) });
  assert.equal(result.item.parentTaskId, pk(parent));
  assert.deepEqual(env.run("update_task", { taskId: pk(project.task), name: "no" }), notApplied("INVALID_OPERATION"));
});

test("date offsets are absolute instants, nullable fields clear, tags replace, completion reads actual state", () => {
  const env = runtime(); const tag = new env.Tag("tag");
  const created = env.run("create_task", { name: "date", dueDate: "2026-10-20T11:00:00+02:00", deferDate: null, tagIds: [pk(tag)], estimatedMinutes: 42 });
  assert.equal(created.item.dueDate, "2026-10-20T09:00:00.000Z"); assert.deepEqual(created.item.tagIds, [pk(tag)]);
  assert.equal(env.state.tasks.at(-1).shouldUseFloatingTimeZone, false);
  const updated = env.run("update_task", { taskId: created.item.id, dueDate: null, tagIds: [], completed: true, estimatedMinutes: null });
  assert.equal(updated.item.completed, true); assert.equal(updated.item.dueDate, null); assert.equal(updated.item.estimatedMinutes, null);
  assert.deepEqual(updated.item.tagIds, []);
  assert.equal(env.run("update_task", { taskId: created.item.id, completed: false }).item.completed, false);
});

test("projects use root note, supported statuses, folder movement and sequential setting", () => {
  const env = runtime(); const folder = { id: { primaryKey: "f" }, kind: "folder" }; env.state.folders.push(folder);
  const created = env.run("create_project", { name: "p", note: "note", folderId: "f", sequential: true, status: "onHold" });
  assert.equal(created.item.noteLength, 4); assert.equal(created.item.status, "onHold"); assert.equal(created.item.folderId, "f");
  const updated = env.run("update_project", { projectId: created.item.id, folderId: null, status: "done", sequential: false });
  assert.equal(updated.item.folderId, null); assert.equal(updated.item.status, "done"); assert.equal(updated.item.sequential, false);
});

test("tag hierarchy movement rejects self and descendant cycles before any edit", () => {
  const env = runtime(); const a = env.run("create_tag", { name: "a", status: "onHold" }).item;
  const b = env.run("create_tag", { name: "b", parentTagId: a.id }).item;
  for (const parentTagId of [a.id, b.id]) {
    const before = env.state.changes;
    assert.deepEqual(env.run("update_tag", { tagId: a.id, name: "no", parentTagId }), notApplied("INVALID_OPERATION"));
    assert.equal(env.state.changes, before);
  }
  const updated = env.run("update_tag", { tagId: b.id, parentTagId: null, status: "dropped" });
  assert.equal(updated.item.parentTagId, null); assert.equal(updated.item.status, "dropped");
});

test("deletion requires exact confirmation and explicit recursive opt-in", () => {
  const env = runtime(); const project = new env.Project("p"); const parent = new env.Task("parent", project); new env.Task("child", parent);
  const tag = new env.Tag("tag"); new env.Tag("nested", tag);
  assert.throws(() => env.run("delete_item", { type: "task", itemId: pk(parent), confirmId: "wrong" }));
  for (const [type, item] of [["project", project], ["task", parent], ["tag", tag]]) {
    const before = env.state.changes;
    const args = { type, itemId: pk(item), confirmId: pk(item) };
    assert.deepEqual(env.run("delete_item", args), notApplied("INVALID_OPERATION")); assert.equal(env.state.changes, before);
    assert.deepEqual(env.run("delete_item", { ...args, includeChildren: true }), { ok: true, item: { type, id: pk(item), deleted: true } });
  }
});

test("any failure after first mutation is unknown and does not claim rollback", () => {
  const env = runtime(); const item = new env.Task("original"); const tag = new env.Tag("tag"); env.state.failAddTags = true;
  const result = env.run("update_task", { taskId: pk(item), name: "changed", tagIds: [pk(tag)] });
  assert.deepEqual(result, { ok: false, errorCode: "WRITE_FAILED", outcome: "unknown" });
  assert.equal(item.name, "changed");
});

test("recurring completion needs opt-in and returns actual completed clone plus original ID", () => {
  const env = runtime(); const item = new env.Task("repeat"); item.repetitionRule = {};
  const before = env.state.changes;
  assert.deepEqual(env.run("update_task", { taskId: pk(item), name: "no", completed: true }), notApplied("INVALID_OPERATION"));
  assert.equal(env.state.changes, before);
  const result = env.run("update_task", { taskId: pk(item), completed: true, allowRepeatingCompletion: true });
  assert.equal(result.item.completed, true); assert.equal(result.item.sourceTaskId, pk(item));
  assert.notEqual(result.item.id, pk(item)); assert.equal(result.item.isRepeating, true); assert.equal(item.completed, false);
});


test("completing a child requires opt-in before a repeating ancestor can auto-complete", () => {
  for (const container of ["group", "project", "grandparent", "destination"]) {
    const env = runtime();
    const project = new env.Project("project");
    const repeated = container === "project" ? project.task : new env.Task("repeat", project);
    repeated.repetitionRule = {}; repeated.completedByChildren = true;
    const parent = container === "grandparent" ? new env.Task("group", repeated) : repeated;
    if (container === "grandparent") parent.completedByChildren = true;
    const child = new env.Task("last child", container === "destination" ? undefined : parent);
    const args = { taskId: pk(child), name: "changed", completed: true,
      ...(container === "destination" ? { parentTaskId: pk(parent) } : {}) };
    const before = env.state.changes;
    assert.deepEqual(env.run("update_task", args), notApplied("INVALID_OPERATION"));
    assert.equal(env.state.changes, before); assert.equal(child.name, "last child");
    const count = env.state.tasks.length;
    const result = env.run("update_task", { ...args, allowRepeatingCompletion: true });
    assert.equal(result.item.completed, true); assert.equal(env.state.tasks.length, count + 1);
  }
});

test("an ancestor without automatic completion stops a repeating completion cascade", () => {
  const env = runtime(); const ancestor = new env.Task("repeat");
  ancestor.repetitionRule = {}; ancestor.completedByChildren = true;
  const parent = new env.Task("manual group", ancestor); const child = new env.Task("child", parent);
  const count = env.state.tasks.length;
  const result = env.run("update_task", { taskId: pk(child), completed: true });
  assert.equal(result.item.completed, true); assert.equal(env.state.tasks.length, count);
  assert.equal(parent.completed, false);
});
