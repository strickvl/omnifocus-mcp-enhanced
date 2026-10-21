import { z } from 'zod';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && url.pathname === '/mcp' && !url.search && !url.hash && !url.username && !url.password && url.port === '';
}, 'publicUrl must be an HTTPS /mcp URL without credentials, port, query or fragment');

const auth = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('local-bearer'), token: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({
    mode: z.literal('cloudflare'),
    issuer: z.string().regex(/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/),
    audience: z.string().min(1).max(256),
    allowedEmails: z.array(z.string().email()).min(1).max(20),
    publicUrl,
  }).strict(),
]);

export const configSchema = z.object({
  port: z.number().int().min(1024).max(65535).default(8787),
  access: z.enum(['read-only', 'read-write']).default('read-only'),
  ledgerDirectory: z.string().refine(isAbsolute, 'ledgerDirectory must be an absolute private directory').optional(),
  auth,
}).strict().superRefine((config, context) => {
  if (config.ledgerDirectory) {
    const path = relative(fileURLToPath(new URL('../../', import.meta.url)), config.ledgerDirectory);
    if (path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))) context.addIssue({code:z.ZodIssueCode.custom,path:['ledgerDirectory'],message:'Write ledger must be outside the repository'});
  }
  if (config.access === 'read-write' && !config.ledgerDirectory) context.addIssue({code:z.ZodIssueCode.custom,path:['ledgerDirectory'],message:'Writes require a durable private ledger directory'});
});
export type Config = z.infer<typeof configSchema>;
