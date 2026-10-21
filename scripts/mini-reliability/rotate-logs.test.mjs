import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rotateLogs, LOG_NAMES, ARCHIVE_LIMIT } from './rotate-logs.mjs';

function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'of-log-test-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('a child writer keeps its original descriptor and writes into the live log after rotation', t => {
  const directory = fixture(t);
  const log = path.join(directory, LOG_NAMES[0]);
  const writer = fs.openSync(log, 'a', 0o600);
  t.after(() => fs.closeSync(writer));
  spawnSync(process.execPath, ['-e', 'process.stdout.write("before rotation\\n")'], { stdio: ['ignore', writer, 'ignore'] });
  const inode = fs.statSync(log).ino;
  assert.equal(rotateLogs(directory, 1).length, 1);
  spawnSync(process.execPath, ['-e', 'process.stdout.write("after rotation\\n")'], { stdio: ['ignore', writer, 'ignore'] });
  assert.equal(fs.statSync(log).ino, inode);
  assert.equal(fs.readFileSync(log, 'utf8'), 'after rotation\n');
  const archives = fs.readdirSync(path.join(directory, 'archives'));
  assert.equal(fs.readFileSync(path.join(directory, 'archives', archives[0]), 'utf8'), 'before rotation\n');
});

test('repeated rotation retains at most 14 archives per allowlisted log and leaves other files untouched', t => {
  const directory = fixture(t);
  const unrelated = path.join(directory, 'http.json');
  fs.writeFileSync(unrelated, 'untouched');
  for (let i = 0; i < 20; i++) {
    for (const name of LOG_NAMES) fs.appendFileSync(path.join(directory, name), `iteration ${i}\n`);
    rotateLogs(directory, 1);
  }
  assert.equal(fs.readdirSync(path.join(directory, 'archives')).length, 56);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'untouched');
  assert.deepEqual(rotateLogs(directory, 1), []);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  for (const file of fs.readdirSync(path.join(directory, 'archives'))) {
    assert.equal(fs.statSync(path.join(directory, 'archives', file)).mode & 0o777, 0o600);
  }
});

test('oversize logs archive only the bounded tail', t => {
  const directory = fixture(t);
  fs.writeFileSync(path.join(directory, LOG_NAMES[0]), Buffer.alloc(ARCHIVE_LIMIT + 17, 65));
  const result = rotateLogs(directory, 1)[0];
  assert.equal(result.droppedOlderBytes, 17);
  const archive = fs.readdirSync(path.join(directory, 'archives'))[0];
  assert.equal(fs.statSync(path.join(directory, 'archives', archive)).size, ARCHIVE_LIMIT);
});

test('symlinks, hard links and concurrent lock fail without truncating their targets', t => {
  const directory = fixture(t);
  const target = path.join(directory, 'protected');
  fs.writeFileSync(target, 'preserved');
  const log = path.join(directory, LOG_NAMES[0]);
  fs.symlinkSync(target, log);
  assert.throws(() => rotateLogs(directory, 1));
  assert.equal(fs.readFileSync(target, 'utf8'), 'preserved');
  fs.unlinkSync(log);
  fs.linkSync(target, log);
  assert.throws(() => rotateLogs(directory, 1));
  fs.unlinkSync(log);
  fs.writeFileSync(path.join(directory, '.rotation.lock'), `${process.pid}\n`);
  assert.throws(() => rotateLogs(directory, 1), /already running/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'preserved');
});


test('a dead child PID lock is reclaimed but malformed lock contents are preserved', t => {
  const directory = fixture(t);
  const child = spawnSync(process.execPath, ['-e', '']);
  assert.equal(child.status, 0);
  const lock = path.join(directory, '.rotation.lock');
  fs.writeFileSync(lock, `${child.pid}\n`);
  const log = path.join(directory, LOG_NAMES[0]);
  fs.writeFileSync(log, 'recover me');
  assert.equal(rotateLogs(directory, 1).length, 1);
  assert.equal(fs.existsSync(lock), false);
  fs.writeFileSync(lock, 'not a PID');
  fs.writeFileSync(log, 'preserve me');
  assert.throws(() => rotateLogs(directory, 1), /Invalid rotation lock/);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'not a PID');
  assert.equal(fs.readFileSync(log, 'utf8'), 'preserve me');
});
