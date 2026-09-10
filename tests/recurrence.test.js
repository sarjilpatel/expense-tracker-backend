// Regression tests for W1-03 (no fallback for an unknown frequency) and W1-16 (scheduling ran in
// server-local time, so a monthly series on the 31st skipped February and landed on the 3rd
// thereafter).

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeNextDueDate, localDayOfMonth, VALID_FREQUENCIES } = require('../utils/recurrence');

const IST = 'Asia/Kolkata';
const NY  = 'America/New_York';
const LON = 'Europe/London';

const wall = (d, tz) => new Intl.DateTimeFormat('en-CA', {
  timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit',
}).format(d);

test('unrecognised frequency returns null rather than the base date', () => {
  // W1-03: the cron's old copy returned `from` unchanged, so the transaction was permanently due
  // and regenerated every hour forever.
  assert.equal(computeNextDueDate(new Date(), 'yearly'), null);
  assert.equal(computeNextDueDate(new Date(), 'fortnightly'), null);
  assert.equal(computeNextDueDate(new Date(), undefined), null);
  assert.equal(computeNextDueDate(new Date(), null), null);
  assert.equal(computeNextDueDate(new Date(), ''), null);
});

test('an unparseable base date returns null', () => {
  assert.equal(computeNextDueDate('not-a-date', 'daily'), null);
  assert.equal(computeNextDueDate(NaN, 'daily'), null);
});

test('the accepted frequencies are exactly daily, weekly, monthly', () => {
  assert.deepEqual([...VALID_FREQUENCIES].sort(), ['daily', 'monthly', 'weekly']);
});

test('daily and weekly advance by whole days', () => {
  assert.equal(
    computeNextDueDate(new Date('2026-06-10T13:00:00Z'), 'daily').toISOString(),
    '2026-06-11T13:00:00.000Z');
  assert.equal(
    computeNextDueDate(new Date('2026-06-10T13:00:00Z'), 'weekly').toISOString(),
    '2026-06-17T13:00:00.000Z');
});

test('monthly rolls over the year', () => {
  assert.equal(
    computeNextDueDate(new Date('2026-12-15T08:00:00Z'), 'monthly').toISOString(),
    '2027-01-15T08:00:00.000Z');
});

test('W1-16: a monthly series on the 31st never skips a month', () => {
  // Before the fix this produced Mar 3, Apr 3, May 3 ... — February vanished and the series was
  // permanently off its anchor.
  let d = new Date('2026-01-31T10:00:00Z');
  const got = [];
  for (let i = 0; i < 5; i++) {
    d = computeNextDueDate(d, 'monthly', { timeZone: 'UTC', anchorDay: 31 });
    got.push(d.toISOString().slice(0, 10));
  }
  assert.deepEqual(got, ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
});

test('without an anchor day a clamped monthly series stays clamped', () => {
  // Documented, deliberate: the anchor is what lets it recover, and callers that have the
  // template's own start date pass it.
  let d = new Date('2026-01-31T10:00:00Z');
  const got = [];
  for (let i = 0; i < 3; i++) {
    d = computeNextDueDate(d, 'monthly', { timeZone: 'UTC' });
    got.push(d.toISOString().slice(0, 10));
  }
  assert.deepEqual(got, ['2026-02-28', '2026-03-28', '2026-04-28']);
});

test('February is handled in both leap and non-leap years', () => {
  assert.equal(
    computeNextDueDate(new Date('2028-01-29T08:00:00Z'), 'monthly', { anchorDay: 29 }).toISOString(),
    '2028-02-29T08:00:00.000Z');
  assert.equal(
    computeNextDueDate(new Date('2026-01-29T08:00:00Z'), 'monthly', { anchorDay: 29 }).toISOString(),
    '2026-02-28T08:00:00.000Z');
});

test('the arithmetic runs in the owner timezone, not the server one', () => {
  // 2026-08-31T19:00Z is already September 1st in India. A monthly series therefore lands on
  // October 1st there, not September 30th.
  const base = new Date('2026-08-31T19:00:00Z');
  assert.equal(wall(computeNextDueDate(base, 'monthly', { timeZone: IST }), IST), '2026-10-01, 00:30');
  assert.equal(computeNextDueDate(base, 'monthly', { timeZone: 'UTC' }).toISOString(),
               '2026-09-30T19:00:00.000Z');
});

test('a due date landing in a DST gap shifts forward past it', () => {
  // 2026-03-08 02:30 does not exist in New York — the clocks jump 02:00 -> 03:00.
  const base = new Date('2026-03-07T07:30:00Z'); // 02:30 EST
  assert.equal(wall(computeNextDueDate(base, 'daily', { timeZone: NY }), NY), '2026-03-08, 03:30');
});

test('local time of day survives a DST change', () => {
  assert.equal(wall(computeNextDueDate(new Date('2026-03-07T14:00:00Z'), 'daily', { timeZone: NY }), NY),
               '2026-03-08, 09:00');
  assert.equal(wall(computeNextDueDate(new Date('2026-10-28T13:00:00Z'), 'weekly', { timeZone: NY }), NY),
               '2026-11-04, 09:00');
  assert.equal(wall(computeNextDueDate(new Date('2026-10-15T08:00:00Z'), 'monthly', { timeZone: LON }), LON),
               '2026-11-15, 09:00');
});

test('a due date landing in a DST fold takes the first occurrence', () => {
  // 2026-11-01 01:30 happens twice in New York; the earlier one is EDT (UTC-4).
  const base = new Date('2026-10-31T05:30:00Z');
  const next = computeNextDueDate(base, 'daily', { timeZone: NY });
  assert.equal(wall(next, NY), '2026-11-01, 01:30');
  assert.equal(next.toISOString(), '2026-11-01T05:30:00.000Z');
});

test('an unknown or missing timezone falls back to UTC instead of throwing', () => {
  // `User.timezone` is only length-bounded by Joi, so a client can put anything in it.
  for (const tz of ['Not/AZone', '', null, undefined, 'Asia/Kolkataa']) {
    assert.equal(
      computeNextDueDate(new Date('2026-06-10T13:00:00Z'), 'daily', { timeZone: tz }).toISOString(),
      '2026-06-11T13:00:00.000Z', `timezone ${JSON.stringify(tz)}`);
  }
  assert.equal(computeNextDueDate(new Date('2026-06-10T13:00:00Z'), 'daily').toISOString(),
               '2026-06-11T13:00:00.000Z');
});

test('two years of monthly steps stay on the anchor day and never skip a month', () => {
  let cur = new Date('2026-01-31T18:30:00Z'); // Feb 1 00:00 IST
  const months = new Set();
  for (let i = 0; i < 24; i++) {
    cur = computeNextDueDate(cur, 'monthly', { timeZone: IST, anchorDay: 1 });
    const parts = wall(cur, IST);
    months.add(parts.slice(0, 7));
    assert.equal(parts.slice(8, 10), '01', `step ${i + 1} landed on ${parts}`);
  }
  assert.equal(months.size, 24);
});

test('localDayOfMonth reports the day in the given zone', () => {
  const t = new Date('2026-08-31T19:00:00Z');
  assert.equal(localDayOfMonth(t, IST), 1);
  assert.equal(localDayOfMonth(t, 'UTC'), 31);
  assert.equal(localDayOfMonth(t, 'Bogus/Zone'), 31);
});
