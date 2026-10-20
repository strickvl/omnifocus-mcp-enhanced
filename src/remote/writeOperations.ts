import { z } from "zod";

const id = z.string().min(1).max(128);
const name = z.string().min(1).max(500);
const timestamp = z.string().datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)));
const key = { idempotencyKey: z.string().min(8).max(128) };
const taskFields = {
  name: name.optional(), note: z.string().max(10000).optional(), flagged: z.boolean().optional(),
  dueDate: timestamp.nullable().optional(), deferDate: timestamp.nullable().optional(),
  estimatedMinutes: z.number().int().min(0).max(525600).nullable().optional(),
  tagIds: z.array(id).max(20).refine(values => new Set(values).size === values.length, "Duplicate tag IDs").optional(),
};
const projectFields = {
  name: name.optional(), note: z.string().max(10000).optional(), folderId: id.nullable().optional(),
  sequential: z.boolean().optional(), status: z.enum(["active", "onHold", "done", "dropped"]).optional(),
};
const tagFields = {
  name: name.optional(), parentTagId: id.nullable().optional(), status: z.enum(["active", "onHold", "dropped"]).optional(),
};
const placement = (args: { projectId?: string | null; parentTaskId?: string }) => args.projectId === undefined || args.parentTaskId === undefined;
const hasChanges = (args: Record<string, unknown>) => Object.keys(args).some(field => !["idempotencyKey", "taskId", "projectId", "tagId", "allowRepeatingCompletion"].includes(field) && args[field] !== undefined);
export const mutationSchemas = {
  create_task: z.object({ ...key, ...taskFields, name, projectId: id.optional(), parentTaskId: id.optional() }).strict().refine(placement, "Choose projectId or parentTaskId"),
  update_task: z.object({ ...key, ...taskFields, taskId: id, completed: z.boolean().optional(), allowRepeatingCompletion: z.boolean().optional(), projectId: id.nullable().optional(), parentTaskId: id.optional() }).strict()
    .refine(placement, "Choose projectId or parentTaskId")
    .refine(args => args.projectId !== undefined || hasChanges(args), "At least one change is required"),
  create_project: z.object({ ...key, ...projectFields, name }).strict(),
  update_project: z.object({ ...key, ...projectFields, projectId: id }).strict().refine(hasChanges, "At least one change is required"),
  create_tag: z.object({ ...key, ...tagFields, name }).strict(),
  update_tag: z.object({ ...key, ...tagFields, tagId: id }).strict().refine(hasChanges, "At least one change is required"),
  delete_item: z.object({ ...key, type: z.enum(["task", "project", "tag"]), itemId: id, confirmId: id, includeChildren: z.boolean().default(false) }).strict()
    .refine(args => args.itemId === args.confirmId, "confirmId must exactly match itemId"),
};
export type MutationName = keyof typeof mutationSchemas;

const base = { id, name: z.string().max(500), nameTruncated: z.boolean() };
const taskResult = z.object({ ...base, type: z.literal("task"), flagged: z.boolean(), completed: z.boolean(),
  dueDate: timestamp.nullable(), deferDate: timestamp.nullable(), estimatedMinutes: z.number().nullable(),
  projectId: id.nullable(), parentTaskId: id.nullable(), inInbox: z.boolean(), isRepeating: z.boolean(), sourceTaskId: id.optional(),
  tagIds: z.array(id).max(20), tagsTruncated: z.boolean(), noteLength: z.number().int().min(0),
}).strict();
const projectResult = z.object({ ...base, type: z.literal("project"), folderId: id.nullable(), sequential: z.boolean(),
  status: z.enum(["active", "onHold", "done", "dropped"]), noteLength: z.number().int().min(0),
}).strict();
const tagResult = z.object({ ...base, type: z.literal("tag"), parentTagId: id.nullable(), status: z.enum(["active", "onHold", "dropped"]) }).strict();
export const mutationResultSchema = z.union([
  z.object({ ok: z.literal(true), item: z.union([taskResult, projectResult, tagResult, z.object({ type: z.enum(["task", "project", "tag"]), id, deleted: z.literal(true) }).strict()]) }).strict(),
  z.object({ ok: z.literal(false), errorCode: z.enum(["NOT_FOUND", "INVALID_OPERATION", "WRITE_FAILED"]), outcome: z.enum(["not_applied", "unknown"]) }).strict(),
]);

// API: omni-automation.com/omnifocus/{task,project,tag,database}.html.
const BODY = String.raw`
  let started = false;
  function fail(code) { throw { mutationCode: code }; }
  function identifier(item) { return item ? String(item.id.primaryKey) : null; }
  function collection(type) {
    return type === "task" ? flattenedTasks : type === "project" ? flattenedProjects : flattenedTags;
  }
  function find(type, value) { return collection(type).find(item => identifier(item) === value) || null; }
  function requireItem(type, value) { const item = find(type, value); if (!item) fail("NOT_FOUND"); return item; }
  function requireFolder(value) { const item = flattenedFolders.find(item => identifier(item) === value); if (!item) fail("NOT_FOUND"); return item; }
  function noCycle(item, parent) {
    const seen = new Set();
    while (parent) {
      const value = identifier(parent);
      if (value === identifier(item) || seen.has(value)) fail("INVALID_OPERATION");
      seen.add(value); parent = parent.parent;
    }
  }
  function repeatsThroughCompletion(parent) {
    const seen = new Set();
    while (parent) {
      const value = identifier(parent);
      if (seen.has(value)) fail("INVALID_OPERATION");
      seen.add(value);
      if (!parent.completedByChildren) return false;
      if (parent.repetitionRule) return true;
      parent = parent.parent;
    }
    return false;
  }
  function statusValue(type, value) {
    const values = type === "project" ? Project.Status : Tag.Status;
    return values[{ active: "Active", onHold: "OnHold", done: "Done", dropped: "Dropped" }[value]];
  }
  function statusName(type, item) {
    const names = type === "project" ? ["active", "onHold", "done", "dropped"] : ["active", "onHold", "dropped"];
    const found = names.find(value => item.status === statusValue(type, value));
    if (!found) fail("WRITE_FAILED"); return found;
  }
  function readback(type, item) {
    const fullName = String(item.name);
    const result = { type, id: identifier(item), name: fullName.slice(0, 500), nameTruncated: fullName.length > 500 };
    if (type === "task") {
      const parent = item.parent;
      Object.assign(result, { flagged: !!item.flagged, completed: !!item.completed,
        dueDate: item.dueDate ? item.dueDate.toISOString() : null, deferDate: item.deferDate ? item.deferDate.toISOString() : null,
        estimatedMinutes: item.estimatedMinutes === null ? null : Number(item.estimatedMinutes),
        projectId: identifier(item.containingProject), parentTaskId: parent && !parent.project ? identifier(parent) : null,
        inInbox: !!item.inInbox, isRepeating: !!item.repetitionRule, tagIds: item.tags.slice(0, 20).map(identifier), tagsTruncated: item.tags.length > 20,
        noteLength: String(item.note || "").length });
    } else if (type === "project") {
      Object.assign(result, { folderId: identifier(item.parentFolder), sequential: !!item.sequential,
        status: statusName(type, item), noteLength: String(item.task.note || "").length });
    } else Object.assign(result, { parentTagId: identifier(item.parent), status: statusName(type, item) });
    return result;
  }
  try {
    const deleting = operation === "delete_item";
    const type = deleting ? args.type : operation.endsWith("_task") ? "task" : operation.endsWith("_project") ? "project" : "tag";
    const creating = operation.startsWith("create_");
    let item = creating ? null : requireItem(type, deleting ? args.itemId : args[type + "Id"]);
    // Root tasks represent projects; task tools must not implicitly alter project structure/status.
    if (type === "task" && item && item.project) fail("INVALID_OPERATION");
    let destination;
    if (type === "task") {
      if (args.projectId !== undefined) destination = args.projectId === null ? inbox.ending : requireItem("project", args.projectId);
      if (args.parentTaskId !== undefined) {
        destination = requireItem("task", args.parentTaskId);
        if (destination.project) fail("INVALID_OPERATION");
        if (item) noCycle(item, destination);
      }
    } else if (type === "project" && args.folderId !== undefined) {
      destination = args.folderId === null ? library.ending : requireFolder(args.folderId);
    } else if (type === "tag" && args.parentTagId !== undefined) {
      destination = args.parentTagId === null ? tags.ending : requireItem("tag", args.parentTagId);
      if (item && args.parentTagId !== null) noCycle(item, destination);
    }
    const resolvedTags = args.tagIds === undefined ? null : args.tagIds.map(value => requireItem("tag", value));
    const dates = {};
    for (const field of ["dueDate", "deferDate"]) if (args[field] !== undefined) {
      dates[field] = args[field] === null ? null : new Date(args[field]);
      if (dates[field] && !Number.isFinite(dates[field].getTime())) fail("INVALID_OPERATION");
    }
    if (args.status !== undefined && statusValue(type, args.status) === undefined) fail("INVALID_OPERATION");
    if (type === "task" && args.completed === true && !item.completed && !args.allowRepeatingCompletion) {
      // Check both existing and requested ancestry before movement or completion can create another occurrence.
      let nextParent = item.parent;
      if (args.parentTaskId !== undefined) nextParent = destination;
      else if (args.projectId !== undefined) nextParent = args.projectId === null ? null : destination.task;
      if (item.repetitionRule || repeatsThroughCompletion(item.parent) || repeatsThroughCompletion(nextParent)) fail("INVALID_OPERATION");
    }
    if (deleting) {
      if (args.confirmId !== args.itemId) fail("INVALID_OPERATION");
      const children = type === "tag" ? item.tags : item.tasks;
      if (children.length && !args.includeChildren) fail("INVALID_OPERATION");
      const deletedId = identifier(item);
      started = true; deleteObject(item);
      if (find(type, deletedId)) fail("WRITE_FAILED");
      return JSON.stringify({ ok: true, item: { type, id: deletedId, deleted: true } });
    }
    if (creating) {
      started = true;
      item = type === "task" ? new Task(args.name, destination) : type === "project" ? new Project(args.name, destination) : new Tag(args.name, destination);
    }
    const properties = type === "task" ? ["name", "note", "flagged", "estimatedMinutes"] : type === "project" ? ["name", "sequential"] : ["name"];
    for (const field of properties) if (args[field] !== undefined) { started = true; item[field] = args[field]; }
    if (type === "project" && args.note !== undefined) { started = true; item.task.note = args.note; }
    for (const field of Object.keys(dates)) { started = true; item[field] = dates[field]; }
    if (Object.keys(dates).some(field => dates[field] !== null)) { started = true; item.shouldUseFloatingTimeZone = false; }
    if (resolvedTags !== null) { started = true; item.clearTags(); item.addTags(resolvedTags); }
    if (args.status !== undefined) { started = true; item.status = statusValue(type, args.status); }
    if (!creating && destination !== undefined) {
      started = true;
      if (type === "task") moveTasks([item], destination);
      else if (type === "project") moveSections([item], destination);
      else moveTags([item], destination);
    }
    let sourceTaskId;
    if (type === "task" && args.completed !== undefined && args.completed !== !!item.completed) {
      started = true;
      if (args.completed) {
        const originalId = identifier(item);
        item = item.markComplete();
        if (identifier(item) !== originalId) sourceTaskId = originalId;
      } else item.markIncomplete();
    }
    const result = readback(type, item);
    if (sourceTaskId) result.sourceTaskId = sourceTaskId;
    return JSON.stringify({ ok: true, item: result });
  } catch (error) {
    return JSON.stringify({ ok: false, errorCode: started ? "WRITE_FAILED" : (error && error.mutationCode || "WRITE_FAILED"), outcome: started ? "unknown" : "not_applied" });
  }
`;
function literal(value: unknown): string {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
export function buildMutationScript(operation: MutationName, input: unknown): string {
  const args = mutationSchemas[operation].parse(input);
  const omni = `(() => { const operation = ${literal(operation)}; const args = JSON.parse(${literal(JSON.stringify(args))}); ${BODY} })()`;
  return `function run() { return Application("OmniFocus").evaluateJavascript(${literal(omni)}); }`;
}
