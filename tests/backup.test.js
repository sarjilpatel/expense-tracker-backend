// W1-15: `scripts/backup.sh` existed and was correct, but nothing ever ran it. It is now started
// in-process so the child inherits the .env a host crontab would never have seen.
//
// The script itself cannot be exercised here — it needs mongodump, the aws CLI and a real bucket —
// so what is pinned is the wrapper: that failures are surfaced, that a hung dump cannot stack, and
// that the job is not scheduled at all when there is nowhere to put a backup.

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');
const { EventEmitter } = require('events');
const { loadWithStubs } = require('./helpers/stubs');
const { loadServerCrons, jobFor } = require('./helpers/serverCron');

const NIGHTLY = '0 2 * * *';

/** A fake child process whose exit the test drives. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = null;
  child.kill = (sig) => { child.killed = sig; };
  return child;
}

/** Loads utils/backup.js with `spawn` replaced, and hands back the spawned child. */
function loadBackup() {
  let spawned = null;
  let child   = null;
  const mod = loadWithStubs('utils/backup.js', {
    child_process: {
      spawn: (cmd, args, opts) => {
        spawned = { cmd, args, opts };
        child = fakeChild();
        return child;
      },
    },
  });
  return { mod, child: () => child, spawned: () => spawned };
}

test('the script is run through bash, not executed directly', async () => {
  // The repo is developed on Windows, so the executable bit does not reliably survive a clone.
  const { mod, child, spawned } = loadBackup();
  const p = mod.runBackup();
  child().emit('close', 0);
  await p;

  assert.equal(spawned().cmd, 'bash');
  assert.equal(path.basename(spawned().args[0]), 'backup.sh');
  assert.ok(path.isAbsolute(spawned().args[0]), 'the path must not depend on the cwd');
});

test('the child inherits the process env', async () => {
  // This is the entire reason the job lives in Node rather than in a host crontab: MONGO_URI and
  // the AWS keys only exist because dotenv loaded them here.
  const { mod, child, spawned } = loadBackup();
  const p = mod.runBackup();
  child().emit('close', 0);
  await p;

  assert.equal(spawned().opts.env, process.env);
});

test('a clean exit resolves with the script output', async () => {
  const { mod, child } = loadBackup();
  const p = mod.runBackup();
  child().stdout.emit('data', Buffer.from('[backup] uploaded 12MB\n'));
  child().emit('close', 0);

  assert.match(await p, /uploaded 12MB/);
});

test('a non-zero exit rejects with the script stderr', async () => {
  // Silence here is how you discover months later that there was never anything to restore from.
  const { mod, child } = loadBackup();
  const p = mod.runBackup();
  child().stderr.emit('data', Buffer.from('mongodump: connection refused'));
  child().emit('close', 1);

  await assert.rejects(p, /exited 1.*connection refused/s);
});

test('a missing bash is reported rather than swallowed', async () => {
  const { mod, child } = loadBackup();
  const p = mod.runBackup();
  child().emit('error', new Error('spawn bash ENOENT'));

  await assert.rejects(p, /Could not run backup script.*ENOENT/s);
});

test('a second backup cannot start while one is in flight', async () => {
  // A hung mongodump must not let the next night stack on top of it — two dumps compete for the
  // same /tmp space and the same Atlas connection budget.
  const { mod, child } = loadBackup();
  const first = mod.runBackup();

  await assert.rejects(mod.runBackup(), /already running/);

  child().emit('close', 0);
  await first;
});

test('the lock is released after a failure, not just after a success', async () => {
  const { mod, child } = loadBackup();
  const first = mod.runBackup();
  child().emit('close', 2);
  await assert.rejects(first);

  // Tomorrow night must still be able to run.
  const second = mod.runBackup();
  child().emit('close', 0);
  await second;
});

test('isBackupConfigured follows the bucket', () => {
  const { mod } = loadBackup();
  const prev = process.env.BACKUP_S3_BUCKET;
  try {
    delete process.env.BACKUP_S3_BUCKET;
    assert.equal(mod.isBackupConfigured(), false);
    process.env.BACKUP_S3_BUCKET = 'my-bucket';
    assert.equal(mod.isBackupConfigured(), true);
  } finally {
    if (prev === undefined) delete process.env.BACKUP_S3_BUCKET;
    else process.env.BACKUP_S3_BUCKET = prev;
  }
});

test('no bucket means the nightly job is never scheduled', () => {
  // Better than scheduling a job that fails every night at 02:00 with nowhere to write.
  const { jobs } = loadServerCrons({}, {
    backup: { isBackupConfigured: () => false, runBackup: async () => '' },
  });
  assert.equal(jobFor(jobs, NIGHTLY), undefined);
});

test('with a bucket set, the job runs at 02:00', async () => {
  let ran = false;
  const { jobs } = loadServerCrons({}, {
    backup: { isBackupConfigured: () => true, runBackup: async () => { ran = true; return 'ok'; } },
  });
  const fn = jobFor(jobs, NIGHTLY);
  assert.ok(fn, 'expected a job on "0 2 * * *"');

  await fn();
  assert.equal(ran, true);
});

test('a failing backup does not take the server down with it', async () => {
  const { jobs } = loadServerCrons({}, {
    backup: {
      isBackupConfigured: () => true,
      runBackup: async () => { throw new Error('mongodump: connection refused'); },
    },
  });
  // The cron body must swallow it after logging — an unhandled rejection here kills the process.
  await jobFor(jobs, NIGHTLY)();
});
