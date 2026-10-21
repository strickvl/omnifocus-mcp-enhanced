import { readFileSync, statSync } from 'node:fs';
import { createHttpApp } from './http.js';
import { configSchema } from './config.js';
import { startReadinessMonitor } from './readiness.js';

try {
  const path = process.env.OMNIFOCUS_HTTP_CONFIG;
  if (!path) throw new Error('OMNIFOCUS_HTTP_CONFIG must name a private JSON config file');
  const stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('Config must be owned by this user with mode 600');
  const config = configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  let readiness: Promise<Awaited<ReturnType<typeof startReadinessMonitor>> | undefined> = Promise.resolve(undefined);
  const server = createHttpApp(config).listen(config.port, '127.0.0.1', () => {
    console.error(`OmniFocus MCP listening on 127.0.0.1:${config.port} (${config.auth.mode}, ${config.access})`);
    const socketPath = process.env.OMNIFOCUS_READINESS_SOCKET;
    if (socketPath) readiness = startReadinessMonitor(socketPath).catch(() => {
      console.error('readiness_start_failed');
      return undefined;
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.maxConnections = 32;
  server.on('error', () => { console.error('HTTP listener failed'); process.exit(1); });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    server.close(() => {
      readiness.then(async monitor => {
        await monitor?.close();
        process.exit(0);
      }).catch(() => process.exit(1));
    });
    setTimeout(() => process.exit(1), 25000).unref();
  });
} catch (error) {
  console.error(error instanceof Error && error.name !== 'ZodError' ? error.message : 'Invalid HTTP configuration');
  process.exit(1);
}
