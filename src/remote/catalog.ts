import { z } from 'zod';
import { runOsascript, serialize, type ReadOnlyOptions } from './automation.js';

export const catalogSchema = z.object({
  kind: z.enum(['projects', 'tags', 'folders', 'perspectives']),
  search: z.string().min(1).max(256).optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict();
const itemSchema = z.object({
  id: z.string().max(128), name: z.string().max(500), nameTruncated: z.boolean(),
  status: z.string().max(32).optional(), parentId: z.string().max(128).nullable().optional(),
}).strict();
const resultSchema = z.object({ items: z.array(itemSchema).max(100), hasMore: z.boolean() }).strict();

export function buildCatalogScript(input: unknown): string {
  const args = catalogSchema.parse(input);
  const script = `(() => {
    const args = ${JSON.stringify(args)};
    const source = args.kind === 'projects' ? flattenedProjects : args.kind === 'tags' ? flattenedTags : args.kind === 'folders' ? flattenedFolders : Perspective.Custom.all;
    const filtered = source.filter(item => !args.search || item.name.toLowerCase().includes(args.search.toLowerCase()));
    const items = filtered.slice(0, args.limit).map(item => {
      const fullName = String(item.name);
      const result = { id: String(args.kind === 'perspectives' ? item.identifier : item.id.primaryKey), name: fullName.slice(0, 500), nameTruncated: fullName.length > 500 };
      if (args.kind === 'projects') {
        const values = [[Project.Status.Active,'active'],[Project.Status.OnHold,'onHold'],[Project.Status.Done,'done'],[Project.Status.Dropped,'dropped']];
        const match = values.find(value => value[0] === item.status);
        result.status = match ? match[1] : 'unknown';
        result.parentId = item.parentFolder ? String(item.parentFolder.id.primaryKey) : null;
      }
      if (args.kind === 'tags') result.parentId = item.parent ? String(item.parent.id.primaryKey) : null;
      return result;
    });
    return JSON.stringify({items, hasMore: filtered.length > items.length});
  })()`;
  return `function run() { return Application('OmniFocus').evaluateJavascript(${JSON.stringify(script)}); }`;
}

export function listItems(input: unknown, options: ReadOnlyOptions = {}) {
  const script = buildCatalogScript(input);
  return serialize(async () => resultSchema.parse(JSON.parse(await (options.runner ?? runOsascript)(script))));
}
