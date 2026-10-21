import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const LOG_NAMES = Object.freeze(['stdout.log', 'stderr.log', 'tunnel-stdout.log', 'tunnel-stderr.log']);
export const LOG_DIRECTORY = '/Users/noor/Library/Logs/OmniFocusMCP';
export const THRESHOLD = 5 * 1024 * 1024;
export const ARCHIVE_LIMIT = 8 * 1024 * 1024;
export const RETAIN = 14;

function privateDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || fs.realpathSync(directory) !== directory) {
    throw new Error('Log directory must be a real, user-owned absolute directory');
  }
  fs.chmodSync(directory, 0o700);
}

function regularPrivateFile(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1) {
    throw new Error('Refusing non-regular, linked, or foreign-owned log file');
  }
  return stat;
}

function acquireLock(lock) {
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY;
  try { return fs.openSync(lock, flags, 0o600); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const before = regularPrivateFile(lock);
  const contents = fs.readFileSync(lock, 'utf8');
  if (!/^[1-9][0-9]{0,9}\n$/.test(contents)) throw new Error('Invalid rotation lock; inspect manually');
  const pid = Number(contents.trim());
  try {
    process.kill(pid, 0);
    throw new Error('Rotation already running');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  const current = regularPrivateFile(lock);
  if (current.ino !== before.ino || current.dev !== before.dev || fs.readFileSync(lock, 'utf8') !== contents) {
    throw new Error('Rotation lock changed; retry later');
  }
  fs.unlinkSync(lock);
  return fs.openSync(lock, flags, 0o600);
}

export function rotateLogs(directory = LOG_DIRECTORY, threshold = THRESHOLD) {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory || !Number.isSafeInteger(threshold) || threshold < 1) {
    throw new Error('Invalid rotation options');
  }
  privateDirectory(directory);
  const archives = path.join(directory, 'archives');
  fs.mkdirSync(archives, { mode: 0o700, recursive: true });
  privateDirectory(archives);
  const lock = path.join(directory, '.rotation.lock');
  const lockFd = acquireLock(lock);
  const results = [];
  try {
    fs.writeSync(lockFd, `${process.pid}\n`);
    for (const name of LOG_NAMES) {
      const source = path.join(directory, name);
      if (!fs.existsSync(source)) continue;
      const before = regularPrivateFile(source);
      const fd = fs.openSync(source, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        if (stat.ino !== before.ino || stat.dev !== before.dev) throw new Error('Log changed while opening');
        fs.fchmodSync(fd, 0o600);
        const prefix = `${name}.`;
        const prior = fs.readdirSync(archives).filter(entry => entry.startsWith(prefix) && /^[0-9]{13}-[0-9a-f-]{36}\.log$/.test(entry.slice(prefix.length))).sort();
        for (const entry of prior) {
          const previous = path.join(archives, entry);
          regularPrivateFile(previous);
          fs.chmodSync(previous, 0o600);
        }
        const keep = stat.size >= threshold ? RETAIN - 1 : RETAIN;
        for (const entry of prior.slice(0, Math.max(0, prior.length - keep))) fs.unlinkSync(path.join(archives, entry));
        if (stat.size < threshold) continue;
        const destination = path.join(archives, `${prefix}${Date.now()}-${randomUUID()}.log`);
        const out = fs.openSync(destination, 'wx', 0o600);
        let complete = false;
        try {
          let position = Math.max(0, stat.size - ARCHIVE_LIMIT);
          const buffer = Buffer.alloc(64 * 1024);
          while (position < stat.size) {
            const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position);
            if (read === 0) throw new Error('Log shortened during copy');
            let written = 0;
            while (written < read) written += fs.writeSync(out, buffer, written, read - written);
            position += read;
          }
          fs.fsyncSync(out);
          complete = true;
        } finally {
          fs.closeSync(out);
          if (!complete) fs.unlinkSync(destination);
        }
        fs.ftruncateSync(fd, 0);
        results.push({ name, archivedBytes: Math.min(stat.size, ARCHIVE_LIMIT), droppedOlderBytes: Math.max(0, stat.size - ARCHIVE_LIMIT) });
      } finally { fs.closeSync(fd); }
    }
    return results;
  } finally {
    fs.closeSync(lockFd);
    fs.unlinkSync(lock);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    // No arguments or environment variables can select production log paths.
    if (process.argv.length !== 2) throw new Error('No arguments supported');
    console.log(JSON.stringify({ rotated: rotateLogs() }));
  } catch (error) {
    console.error(`Log rotation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
