import { chmodSync, lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { dirname, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAutomationIdle, queryTasks, type ReadOnlyOptions } from './automation.js';

const PROBE_INTERVAL_MS = 5 * 60_000;
const STALE_AFTER_MS = 10 * 60_000;
const SOURCE_ROOT = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const CANARY_SEARCH = '__omnifocus_readiness_canary_7bd649aa_nonexistent__';

function socketIsLive(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Readiness socket check timed out')); });
    socket.once('error', error => {
      socket.destroy();
      if ('code' in error && error.code === 'ECONNREFUSED') resolve(false);
      else reject(new Error('Readiness socket check failed'));
    });
  });
}

async function prepareSocket(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error('Readiness socket must use an absolute path');
  const parent = dirname(path);
  const directory = lstatSync(parent);
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o777) !== 0o700 || realpathSync(parent) !== parent) {
    throw new Error('Readiness socket requires an existing private user-owned directory');
  }
  const withinSource = relative(SOURCE_ROOT, path);
  if (withinSource === '' || (!withinSource.startsWith('../') && !isAbsolute(withinSource))) {
    throw new Error('Readiness socket must be outside the source directory');
  }
  let existing;
  try { existing = lstatSync(path); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  if (!existing.isSocket() || existing.uid !== process.getuid?.()) throw new Error('Readiness socket path is occupied');
  if (await socketIsLive(path)) throw new Error('Readiness socket is already active');
  const current = lstatSync(path);
  if (!current.isSocket() || current.uid !== existing.uid || current.dev !== existing.dev || current.ino !== existing.ino) {
    throw new Error('Readiness socket changed during startup');
  }
  unlinkSync(path);
}

export async function startReadinessMonitor(path: string, options: ReadOnlyOptions & {
  now?: () => number;
  log?: (event: string) => void;
} = {}) {
  await prepareSocket(path);
  const now = options.now ?? Date.now;
  const log = options.log ?? console.error;
  let stopped = false;
  let activeProbe: Promise<void> | undefined;
  let lastAttemptAt: number | null = null;
  let lastSuccessAt: number | null = null;
  let succeeded = false;
  const probe = () => {
    if (stopped || activeProbe || !isAutomationIdle()) return Promise.resolve();
    lastAttemptAt = now();
    activeProbe = (async () => {
      try {
        await queryTasks({ search: CANARY_SEARCH, limit: 1, includeNotes: false }, options);
        lastSuccessAt = now();
        succeeded = true;
      } catch {
        succeeded = false;
        log('readiness_probe_failed');
      } finally { activeProbe = undefined; }
    })();
    return activeProbe;
  };
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET' || request.url !== '/readyz') { response.writeHead(404).end(); return; }
    const ready = succeeded && lastSuccessAt !== null && now() - lastSuccessAt < STALE_AFTER_MS;
    response.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ready, lastAttemptAt, lastSuccessAt }));
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxConnections = 16;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.off('error', reject); resolve(); });
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  const close = async () => {
    stopped = true;
    clearInterval(timer);
    const closed = new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await Promise.all([closed, activeProbe]);
  };
  server.on('error', () => {
    log('readiness_listener_failed');
    close().catch(() => log('readiness_cleanup_failed'));
  });
  try { chmodSync(path, 0o600); }
  catch (error) { await close(); throw error; }
  const runProbe = () => { probe().catch(() => log('readiness_probe_failed')); };
  timer = setInterval(runProbe, PROBE_INTERVAL_MS);
  timer.unref();
  runProbe();
  return { close, probe };
}
