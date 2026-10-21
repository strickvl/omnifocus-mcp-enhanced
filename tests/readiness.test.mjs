import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { isAutomationIdle, serialize } from '../dist/remote/automation.js';
import { startReadinessMonitor } from '../dist/remote/readiness.js';
import { createHttpApp } from '../dist/remote/http.js';
import { configSchema } from '../dist/remote/config.js';

const empty = '{"tasks":[],"hasMore":false}';
function fixture(t, prefix = '/private/tmp/of-ready-') {
  const directory = mkdtempSync(prefix);
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'ready.sock') };
}
function get(path, route = '/readyz', method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: path, path: route, method, headers: { host: 'localhost:8787' }, agent: false }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('cached readiness fails, recovers, and expires without exposing task or failure data', async t => {
  const { path } = fixture(t);
  let clock = 1_000_000;
  let fail = true;
  let calls = 0;
  const events = [];
  const monitor = await startReadinessMonitor(path, {
    now: () => clock,
    log: event => events.push(event),
    runner: async script => {
      calls++;
      assert.match(script, /__omnifocus_readiness_canary_/);
      if (fail) throw new Error('private task contents');
      return empty;
    },
  });
  t.after(() => monitor.close());
  await tick();
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
  let response = await get(path);
  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(response.body), { ready: false, lastAttemptAt: clock, lastSuccessAt: null });
  assert.deepEqual(events, ['readiness_probe_failed']);
  fail = false;
  clock += 300_000;
  await monitor.probe();
  response = await get(path);
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(response.body), { ready: true, lastAttemptAt: clock, lastSuccessAt: clock });
  assert.equal((await get(path)).status, 200);
  assert.equal(calls, 2, 'HTTP requests only read the cache');
  clock += 600_000;
  assert.equal((await get(path)).status, 503);
  assert.equal(calls, 2);
  fail = true;
  await monitor.probe();
  assert.equal((await get(path)).status, 503);
  fail = false;
  await monitor.probe();
  assert.equal((await get(path)).status, 200);
  assert.equal((await get(path, '/health')).status, 404);
  assert.equal((await get(path, '/readyz', 'POST')).status, 404);
  await monitor.close();
  assert.equal(existsSync(path), false);
});

test('busy or pending shared automation skips probes and an active probe serializes other work', async t => {
  const { path } = fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const active = serialize(() => gate);
  const queued = serialize(async () => { await tick(); });
  let calls = 0;
  let releaseProbe;
  const probeGate = new Promise(resolve => { releaseProbe = resolve; });
  const monitor = await startReadinessMonitor(path, { runner: async () => { calls++; await probeGate; return empty; } });
  t.after(() => monitor.close());
  assert.equal(isAutomationIdle(), false);
  await monitor.probe();
  assert.equal(calls, 0);
  assert.deepEqual(JSON.parse((await get(path)).body), { ready: false, lastAttemptAt: null, lastSuccessAt: null });
  release();
  await Promise.all([active, queued]);
  await tick();
  assert.equal(isAutomationIdle(), true);
  const probe = monitor.probe();
  assert.equal(calls, 1);
  let otherRan = false;
  const other = serialize(async () => { otherRan = true; });
  await monitor.probe();
  assert.equal(calls, 1);
  assert.equal(otherRan, false);
  let closed = false;
  const closing = monitor.close().then(() => { closed = true; });
  await tick();
  assert.equal(closed, false, 'shutdown waits for the bounded automation child to finish');
  releaseProbe();
  await Promise.all([probe, other, closing]);
  assert.equal(otherRan, true);
  assert.equal(closed, true);
});

test('socket startup rejects unsafe paths and preserves occupied files and active sockets', async t => {
  const { directory, path } = fixture(t);
  const options = { runner: async () => empty };
  await assert.rejects(startReadinessMonitor('relative.sock', options), /absolute/);
  chmodSync(directory, 0o755);
  await assert.rejects(startReadinessMonitor(path, options), /private/);
  chmodSync(directory, 0o700);
  writeFileSync(path, 'preserve');
  await assert.rejects(startReadinessMonitor(path, options), /occupied/);
  assert.equal(lstatSync(path).isFile(), true);
  rmSync(path);
  const alias = join(directory, 'alias');
  symlinkSync(directory, alias);
  await assert.rejects(startReadinessMonitor(join(alias, 'ready.sock'), options), /private/);
  symlinkSync(join(directory, 'missing'), path);
  await assert.rejects(startReadinessMonitor(path, options), /occupied/);
  rmSync(path);
  const live = createServer(socket => socket.end());
  await new Promise(resolve => live.listen(path, resolve));
  t.after(() => new Promise(resolve => live.close(resolve)));
  const inode = lstatSync(path).ino;
  await assert.rejects(startReadinessMonitor(path, options), /already active/);
  assert.equal(lstatSync(path).ino, inode);
  const inside = fixture(t, join(process.cwd(), '.ready-test-'));
  await assert.rejects(startReadinessMonitor(inside.path, options), /outside/);
});

test('a socket left by a terminated process is safely replaced and removed on shutdown', async t => {
  const { path } = fixture(t);
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    'import {createServer} from "node:net"; createServer().listen(process.argv[1], () => process.stdout.write("ready"));', path],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(([code]) => { throw new Error(`Socket fixture exited: ${code}`); })]);
  child.kill('SIGKILL');
  await once(child, 'exit');
  assert.equal(lstatSync(path).isSocket(), true);
  const monitor = await startReadinessMonitor(path, { runner: async () => empty });
  t.after(() => monitor.close());
  await tick();
  assert.equal((await get(path)).status, 200);
  await monitor.close();
  assert.equal(existsSync(path), false);
});

test('the MCP listener has no readiness route and its configuration schema remains unchanged', async t => {
  const { path } = fixture(t);
  const config = { port: 8787, auth: { mode: 'local-bearer', token: 'a'.repeat(64) } };
  assert.equal(configSchema.safeParse({ ...config, readinessSocket: path }).success, false);
  const server = createHttpApp(config).listen(path);
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal((await get(path)).status, 404);
});
