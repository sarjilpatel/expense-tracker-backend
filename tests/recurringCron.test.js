// W1-02 / W1-03 / W1-04 / W1-16 regressions, run against the real cron body in server.js.
//
// The hourly recurring job caused more damage than anything else in Phase 1: it marked every
// generated occurrence as recurring (doubling the series each period), it threw on solo users and
// aborted the rest of the batch, it kept firing for soft-deleted templates, and it stepped the
// schedule from the tick time rather than from the due date.

const test   = require('node:test');
const assert = require('node:assert/strict');
const { loadServerCrons, jobFor } = require('./helpers/serverCron');
const { atTime } = require('./helpers/stubs');

const HOURLY = '0 * * * *';

/**
 * Runs the hourly job over `templates` at the frozen time `nowIso`.
 * Returns what it created, what it saved back and what it emitted.
 */
async function runHourly(templates, nowIso, { timezones = {} } = {}) {
  const created = [];
  const queries = [];

  const docs = templates.map((t) => ({
    _id: 't1', amount: 100, type: 'expense', category: 'Bills', note: 'rent',
    userId: 'u1', groupId: null, currency: 'INR', isPrivate: false,
    // `date` always exists on a real row (the model defaults it) and is what anchors a
    // monthly series to its day-of-month.
    date: '2026-09-10T10:30:00Z',
    isRecurring: true, recurrenceFrequency: 'monthly', deletedAt: null,
    saves: 0,
    async save() { this.saves += 1; },
    ...t,
  }));

  const models = {
    './models/Transaction': {
      find: async (q) => { queries.push(q); return docs; },
      create: async (doc) => { created.push(doc); return { ...doc, _id: 'generated' }; },
      deleteMany: async () => {},
    },
    './models/User': {
      find: (filter) => ({
        lean: async () => filter._id.$in.map((id) => ({ _id: id, timezone: timezones[id] })),
      }),
      deleteMany: async () => {}, findByIdAndDelete: async () => {},
    },
  };

  const { jobs, emitted } = loadServerCrons(models);
  const fn = jobFor(jobs, HOURLY);
  assert.ok(fn, 'the hourly recurring job must be scheduled');
  await atTime(nowIso, () => fn());
  return { created, docs, emitted, query: queries[0] };
}

test('the hourly job is registered', async () => {
  const { jobs } = loadServerCrons();
  assert.ok(jobFor(jobs, HOURLY), 'expected a job on "0 * * * *"');
});

test('only live, due templates are picked up', async () => {
  // deletedAt is a soft delete: without this clause a deleted template generated forever.
  const { query } = await runHourly(
    [{ nextDueDate: '2026-09-10T00:00:00Z' }], '2026-09-10T10:00:00Z');

  assert.equal(query.isRecurring, true);
  assert.equal(query.deletedAt, null);
  assert.ok(query.nextDueDate.$lte, 'a due-date window is required');
});

test('the lookahead window is one hour, not open-ended', async () => {
  const { query } = await runHourly(
    [{ nextDueDate: '2026-09-10T00:00:00Z' }], '2026-09-10T10:00:00Z');

  const end = new Date(query.nextDueDate.$lte).getTime();
  assert.equal(end - new Date('2026-09-10T10:00:00Z').getTime(), 60 * 60 * 1000);
});

test('the generated occurrence is not itself recurring', async () => {
  // This was the doubling bug: each occurrence became a template of its own.
  const { created } = await runHourly(
    [{ nextDueDate: '2026-09-10T10:30:00Z' }], '2026-09-10T10:00:00Z');

  assert.equal(created.length, 1);
  assert.equal(created[0].isRecurring, false);
  assert.equal(created[0].recurrenceFrequency, null);
  assert.equal(created[0].nextDueDate, null);
});

test('the occurrence is stamped with the scheduled time, not the tick time', async () => {
  // With a 1-hour lookahead the cron fires before the occurrence is due; using `now` filed it
  // under the previous local day in timezones east of UTC.
  const { created } = await runHourly(
    [{ nextDueDate: '2026-09-10T10:30:00Z' }], '2026-09-10T10:00:00Z');

  assert.equal(new Date(created[0].date).toISOString(), '2026-09-10T10:30:00.000Z');
});

test('exactly one occurrence is generated per tick', async () => {
  const { created, docs } = await runHourly(
    [{ nextDueDate: '2026-09-10T10:30:00Z' }], '2026-09-10T10:00:00Z');

  assert.equal(created.length, 1);
  assert.equal(docs[0].saves, 1, 'the template advances once');
});

test('a solo user with no group does not abort the batch', async () => {
  // `tx.groupId.toString()` on null threw and skipped every remaining template in the run.
  const { created } = await runHourly([
    { _id: 'solo', groupId: null, nextDueDate: '2026-09-10T10:30:00Z' },
    { _id: 'next', groupId: null, nextDueDate: '2026-09-10T10:30:00Z', category: 'Food' },
  ], '2026-09-10T10:00:00Z');

  assert.equal(created.length, 2, 'the second template must still run');
});

test('a group occurrence is broadcast to the group room', async () => {
  const { emitted } = await runHourly(
    [{ groupId: 'g1', nextDueDate: '2026-09-10T10:30:00Z' }], '2026-09-10T10:00:00Z');

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].room, 'g1');
  assert.equal(emitted[0].ev, 'group_changed', 'a signal to pull, not the row itself (W3-22)');
  assert.equal(emitted[0].payload.by, 'server');
});

test('a malformed template does not stop the ones after it', async () => {
  const { created } = await runHourly([
    // A row whose stored date cannot be read at all — the worst case the loop has to absorb.
    { _id: 'bad',  nextDueDate: { toString() { throw new Error('corrupt row'); } } },
    { _id: 'good', nextDueDate: '2026-09-10T10:30:00Z' },
  ], '2026-09-10T10:00:00Z');

  assert.equal(created.length, 1, 'the good template still runs');
  assert.equal(created[0].category, 'Bills');
});

test('an unrecognised frequency retires the template instead of looping forever', async () => {
  const { created, docs } = await runHourly(
    [{ recurrenceFrequency: 'fortnightly', nextDueDate: '2026-09-10T10:30:00Z' }],
    '2026-09-10T10:00:00Z');

  assert.equal(created.length, 0);
  assert.equal(docs[0].isRecurring, false);
  assert.equal(docs[0].nextDueDate, null);
  assert.equal(docs[0].saves, 1);
});

test('the schedule advances from the due date, not from the tick time', async () => {
  // Stepping from `now` dragged a series onto whatever hour the cron happened to fire.
  const { docs } = await runHourly(
    [{ recurrenceFrequency: 'daily', nextDueDate: '2026-09-10T10:30:00Z' }],
    '2026-09-10T10:00:00Z');

  assert.equal(new Date(docs[0].nextDueDate).toISOString(), '2026-09-11T10:30:00.000Z');
});

test('a monthly series stays pinned to the day it started on', async () => {
  // W1-16: Jan 31 -> Mar 3 -> Apr 3 permanently skipped February. The anchor comes from the
  // template's own `date`, so the series returns to the 31st in months that have one.
  const { docs } = await runHourly([{
    recurrenceFrequency: 'monthly',
    date: '2026-01-31T10:30:00Z',
    nextDueDate: '2026-01-31T10:30:00Z',
  }], '2026-01-31T10:00:00Z');

  assert.equal(new Date(docs[0].nextDueDate).toISOString(), '2026-02-28T10:30:00.000Z');
});

test('the next due date is computed in the owner timezone', async () => {
  // 19:00Z is 00:30 the next day in IST, so "monthly" has to mean the same local day-of-month.
  const { docs } = await runHourly([{
    userId: 'ist',
    recurrenceFrequency: 'monthly',
    date: '2026-08-31T19:00:00Z',
    nextDueDate: '2026-08-31T19:00:00Z',
  }], '2026-08-31T18:30:00Z', { timezones: { ist: 'Asia/Kolkata' } });

  // 2026-09-01 00:30 IST -> next month is 2026-10-01 00:30 IST -> 2026-09-30T19:00Z.
  assert.equal(new Date(docs[0].nextDueDate).toISOString(), '2026-09-30T19:00:00.000Z');
});

test('a missed stretch is walked forward rather than fired hourly', async () => {
  // The server was down for two weeks. The next due date must land in the future in one tick,
  // otherwise the template is due again an hour later, and every hour after that.
  const now = '2026-09-20T10:00:00Z';
  const { created, docs } = await runHourly(
    [{ recurrenceFrequency: 'daily', nextDueDate: '2026-09-05T10:30:00Z' }], now);

  assert.equal(created.length, 1, 'still exactly one occurrence per tick');
  assert.ok(new Date(docs[0].nextDueDate) > new Date(now),
    'the series must be caught up, not left in the past');
  assert.equal(new Date(docs[0].nextDueDate).toISOString(), '2026-09-20T10:30:00.000Z');
});

test('a template with no nextDueDate is scheduled from now instead of crashing', async () => {
  const { docs, created } = await runHourly(
    [{ recurrenceFrequency: 'daily', nextDueDate: null }], '2026-09-10T10:00:00Z');

  assert.equal(created.length, 1);
  assert.equal(new Date(docs[0].nextDueDate).toISOString(), '2026-09-11T10:00:00.000Z');
});
