// W1-30 regression: `User.timezone` was written once, at signup, and never again. Since W1-16 that
// field decides when a user's recurring transactions fire (`server.js` hourly cron ->
// `utils/recurrence.js`), so a user who moved kept firing on their old day forever, and nothing in
// the app — not login, not settings, not startup — could correct it.
//
// `PATCH /api/auth/timezone` is that missing write. It was made its own endpoint rather than a
// field on the login response because a long-lived session may never log in again, which is
// exactly the session a traveller has.
//
// Two rules are pinned here beyond "it saves":
//   * an unknown zone is rejected, not stored. Everything downstream falls back to UTC on a bad
//     value, which is right when reading and wrong when storing — it would leave the schedule
//     quietly wrong with nothing to point at.
//   * a call that changes nothing writes nothing. The app sends this on every start.

const test   = require('node:test');
const assert = require('node:assert/strict');
const { loadWithStubs, mockRes } = require('./helpers/stubs');
const { isValidTimeZone } = require('../utils/recurrence');

const USER = 'user1';

/** Loads the controller with a User stub that records the update it was given. */
function load({ modifiedCount = 1, throws = false } = {}) {
  const calls = { update: null, create: null, otp: null };
  const ctrl = loadWithStubs('controllers/authController.js', {
    '../models/User': {
      updateOne: async (filter, doc) => {
        calls.update = { filter, doc };
        if (throws) throw new Error('mongo is down');
        return { modifiedCount };
      },
      findOne: async () => null,
      create: async (doc) => {
        calls.create = doc;
        return { ...doc, _id: 'u1', toObject: () => ({ ...doc, _id: 'u1' }) };
      },
    },
    '../utils/mailer': { sendOtpEmail: async () => {} },
    // Signup no longer writes a user (W1-32) — the zone rides on the OTP payload until the code
    // comes back, so that payload is what these tests read.
    '../utils/otp': {
      issueOtp: async (args) => { calls.otp = args; return { code: '123456', ttlMinutes: 10 }; },
      verifyOtp: async () => ({ ok: false, reason: 'invalid', attemptsLeft: 4 }),
      TTL_MINUTES: 10,
    },
    '../utils/rateLimit': {
      consume: async () => ({ allowed: true, retryAfterSeconds: 0 }),
      clientIp: () => '1.2.3.4',
    },
    '../models/Otp': { findOne: () => ({ sort: async () => null }) },
    '../utils/tokens': {
      issueTokens:      () => ({ token: 't', refreshToken: 'r' }),
      signAccessToken:  () => 't',
      signRefreshToken: () => 'r',
    },
  });
  return { ctrl, calls };
}

const req = (timezone) => ({ user: { id: USER }, body: { timezone } });

// --- isValidTimeZone -------------------------------------------------------------------------

test('a real IANA zone is valid', () => {
  assert.equal(isValidTimeZone('Asia/Kolkata'), true);
  assert.equal(isValidTimeZone('America/New_York'), true);
  assert.equal(isValidTimeZone('UTC'), true);
});

test('a string that is not a zone is not valid', () => {
  // The distinction the whole endpoint rests on: `resolveZone` answers 'UTC' for both a real UTC
  // and a junk value, so validity has to be "the runtime gave the string back", not "it resolved".
  assert.equal(isValidTimeZone('Mars/Olympus_Mons'), false);
  assert.equal(isValidTimeZone('not a zone'), false);
});

test('a missing or non-string zone is not valid', () => {
  for (const bad of [undefined, null, '', 0, 42, {}, ['UTC']]) {
    assert.equal(isValidTimeZone(bad), false, `${JSON.stringify(bad)} must not pass`);
  }
});

// --- PATCH /api/auth/timezone ---------------------------------------------------------------

test('a new zone is written to the caller and only the caller', async () => {
  const { ctrl, calls } = load();
  const res = mockRes();
  await ctrl.updateTimezone(req('Asia/Kolkata'), res);

  assert.equal(res.statusCode, null, JSON.stringify(res.body));
  assert.deepEqual(res.body, { timezone: 'Asia/Kolkata', updated: true });
  assert.equal(calls.update.filter._id, USER);
  assert.deepEqual(calls.update.doc, { timezone: 'Asia/Kolkata' });
});

test('an unknown zone is rejected and nothing is written', async () => {
  const { ctrl, calls } = load();
  const res = mockRes();
  await ctrl.updateTimezone(req('Mars/Olympus_Mons'), res);

  assert.equal(res.statusCode, 400);
  assert.equal(calls.update, null, 'a bad zone must not reach the database at all');
});

test('the stored zone survives a bad update — it is not cleared on the way to the 400', async () => {
  // Rejecting has to mean keeping. If a bad value cleared the field, a single stale device would
  // reset a correct schedule to UTC.
  const { ctrl, calls } = load();
  await ctrl.updateTimezone(req('nonsense'), mockRes());
  assert.equal(calls.update, null);
});

test('an unchanged zone is not a write', async () => {
  // `modifiedCount: 0` is what Mongo answers when the `$ne` filter matched nothing — i.e. the user
  // already had this zone. The app calls this on every start, so this is the common case.
  const { ctrl, calls } = load({ modifiedCount: 0 });
  const res = mockRes();
  await ctrl.updateTimezone(req('UTC'), res);

  assert.equal(res.statusCode, null);
  assert.deepEqual(res.body, { timezone: 'UTC', updated: false });
  assert.deepEqual(calls.update.filter, { _id: USER, timezone: { $ne: 'UTC' } },
    'the no-op has to be skipped by the query, not after it');
});

test('a database failure is a 500, not a silent success', async () => {
  const { ctrl } = load({ throws: true });
  const res = mockRes();
  await ctrl.updateTimezone(req('Europe/Berlin'), res);

  assert.equal(res.statusCode, 500);
});

// --- signup ----------------------------------------------------------------------------------

// Signup writes no user at all now: the zone travels on the OTP payload and is copied onto the
// account by verifySignup. The validity rule is unchanged and still belongs here — it is the
// reason an unknown zone can never reach the database by either route.

const signupReq = (body) => ({ body, ip: '1.2.3.4' });

test('signup carries the zone the device sent on the pending payload', async () => {
  const { ctrl, calls } = load();
  await ctrl.signup(signupReq({ name: 'A', email: 'a@b.c', password: 'x', timezone: 'Asia/Kolkata' }), mockRes());
  assert.equal(calls.otp.payload.timezone, 'Asia/Kolkata');
  assert.equal(calls.create, null, 'no user may be written before the code is verified');
});

test('signup coerces a junk zone to UTC instead of carrying it', async () => {
  // Signup took whatever the body carried. A device sending a zone this runtime does not know
  // would have had every recurring transaction it later created resolved against UTC anyway —
  // storing the junk only made that impossible to see.
  const { ctrl, calls } = load();
  await ctrl.signup(signupReq({ name: 'A', email: 'a@b.c', password: 'x', timezone: 'Mars/Base' }), mockRes());
  assert.equal(calls.otp.payload.timezone, 'UTC');
});

test('signup with no zone at all still gets one', async () => {
  const { ctrl, calls } = load();
  await ctrl.signup(signupReq({ name: 'A', email: 'a@b.c', password: 'x' }), mockRes());
  assert.equal(calls.otp.payload.timezone, 'UTC');
});
