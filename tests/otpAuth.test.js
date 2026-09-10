// W1-32: email auth by six-digit code, ported from the mrg-dashboard flow.
//
// What replaced what, and why each replacement is pinned here:
//
//   * Signup used to create the user immediately and mail a 24-hour verification link. Anyone who
//     typed an address owned it from that moment, verified or not, and the link only worked if the
//     app was installed and the mail client honoured the deep-link scheme. Now signup writes
//     nothing: the name, the password hash and the zone ride on the OTP document, and the account
//     is created by the code coming back. An abandoned signup leaves no row at all.
//   * Password reset used to be a link carrying a random token. It is a code now, so the same
//     three screens work from a desktop inbox with the phone in hand.
//   * Both send endpoints answer identically whether or not the address is registered. That is
//     the whole point of the neutral copy, and it is worth a test because the natural way to
//     write either handler leaks the answer through a status code or a timing-free early return.
//
// Codes are bcrypt-hashed, single-use, 10 minutes, 5 attempts. The tests below are the record of
// each of those being load-bearing rather than decorative.

const test   = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { loadWithStubs, mockRes } = require('./helpers/stubs');

// --- a stand-in for the Otp collection -------------------------------------------------------
// Enough Mongoose surface for utils/otp.js: findOne().sort(), create, deleteMany, deleteOne,
// updateOne, findOneAndUpdate. Rows are plain objects, so a test can read `codeHash` directly and
// assert that the plaintext never reached storage.
function fakeOtpModel() {
  const rows = [];
  let seq = 0;
  const match = (row, filter) => Object.entries(filter).every(([k, v]) => {
    if (k === '_id') return row._id === v;
    if (v === null)  return row[k] == null;
    return row[k] === v;
  });
  return {
    rows,
    async create(doc) {
      const row = { _id: `otp${++seq}`, attempts: 0, consumedAt: null, createdAt: new Date(Date.now() + seq), ...doc };
      rows.push(row);
      return row;
    },
    findOne(filter) {
      const hits = rows.filter(r => match(r, filter));
      const pick = async () => hits.sort((a, b) => b.createdAt - a.createdAt)[0] || null;
      return { sort: pick, then: (res, rej) => pick().then(res, rej) };
    },
    async deleteMany(filter) {
      for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i], filter)) rows.splice(i, 1);
    },
    async deleteOne(filter) {
      const i = rows.findIndex(r => match(r, filter));
      if (i >= 0) rows.splice(i, 1);
    },
    async updateOne(filter, update) {
      const row = rows.find(r => match(r, filter));
      if (row && update.$inc) for (const [k, n] of Object.entries(update.$inc)) row[k] = (row[k] || 0) + n;
    },
    async findOneAndUpdate(filter, update) {
      const row = rows.find(r => match(r, filter));
      if (!row) return null;
      if (update.$set) Object.assign(row, update.$set);
      return row;
    },
  };
}

const loadOtp = (Otp) => loadWithStubs('utils/otp.js', { '../models/Otp': Otp });

// --- utils/otp.js ----------------------------------------------------------------------------

test('a code is six digits and is stored hashed, never in the clear', async () => {
  const Otp = fakeOtpModel();
  const otp = loadOtp(Otp);

  const { code } = await otp.issueOtp({ email: 'a@b.c', purpose: 'signup', payload: { name: 'A' } });

  assert.match(code, /^\d{6}$/);
  assert.equal(Otp.rows.length, 1);
  assert.notEqual(Otp.rows[0].codeHash, code);
  assert.equal(await bcrypt.compare(code, Otp.rows[0].codeHash), true);
});

test('issuing a code invalidates the previous unused one', async () => {
  // Otherwise every resend widens the set of live codes, and the 5-attempt cap stops meaning
  // anything: an attacker just asks for more codes and keeps five guesses against each.
  const Otp = fakeOtpModel();
  const otp = loadOtp(Otp);

  const first  = await otp.issueOtp({ email: 'a@b.c', purpose: 'signup' });
  const second = await otp.issueOtp({ email: 'a@b.c', purpose: 'signup' });

  assert.equal(Otp.rows.length, 1);
  assert.equal(await otp.verifyOtp({ email: 'a@b.c', purpose: 'signup', code: first.code }).then(r => r.ok), false);
  assert.equal(await otp.verifyOtp({ email: 'a@b.c', purpose: 'signup', code: second.code }).then(r => r.ok), true);
});

test('a correct code returns the payload it was issued with', async () => {
  const Otp = fakeOtpModel();
  const otp = loadOtp(Otp);

  const { code } = await otp.issueOtp({ email: 'a@b.c', purpose: 'signup', payload: { name: 'Ada', passwordHash: 'h' } });
  const result = await otp.verifyOtp({ email: 'a@b.c', purpose: 'signup', code });

  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, { name: 'Ada', passwordHash: 'h' });
});

test('a code works once', async () => {
  const Otp = fakeOtpModel();
  const otp = loadOtp(Otp);

  const { code } = await otp.issueOtp({ email: 'a@b.c', purpose: 'signup', payload: { passwordHash: 'h' } });
  assert.equal((await otp.verifyOtp({ email: 'a@b.c', purpose: 'signup', code })).ok, true);

  const second = await otp.verifyOtp({ email: 'a@b.c', purpose: 'signup', code });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'invalid');
});

test('a code for one purpose is not a code for the other', async () => {
  const Otp = fakeOtpModel();
  const otp = loadOtp(Otp);

  const { code } = await otp.issueOtp({ email: 'a@b.c', purpose: 'signup', payload: { passwordHash: 'h' } });
  const crossed = await otp.verifyOtp({ email: 'a@b.c', purpose: 'reset', code });

  assert.equal(crossed.ok, false);
});

test('an expired code is refused and destroyed', async () => {
  // The TTL index only sweeps once a minute, so an expired row is readable for up to a minute
  // after it dies — verifyOtp has to check the clock itself.
  const Otp = fakeOtpModel();
  const otp = loadOtp(Otp);

  const { code } = await otp.issueOtp({ email: 'a@b.c', purpose: 'reset' });
  Otp.rows[0].expiresAt = new Date(Date.now() - 1000);

  const result = await otp.verifyOtp({ email: 'a@b.c', purpose: 'reset', code });
  assert.equal(result.reason, 'expired');
  assert.equal(Otp.rows.length, 0);
});

test('a wrong guess costs an attempt and says how many are left', async () => {
  const Otp = fakeOtpModel();
  const otp = loadOtp(Otp);

  const { code } = await otp.issueOtp({ email: 'a@b.c', purpose: 'reset' });
  const wrong = code === '000000' ? '111111' : '000000';

  const first = await otp.verifyOtp({ email: 'a@b.c', purpose: 'reset', code: wrong });
  assert.equal(first.reason, 'invalid');
  assert.equal(first.attemptsLeft, 4);
  assert.equal(Otp.rows[0].attempts, 1);
});

test('the fifth wrong guess destroys the code', async () => {
  const Otp = fakeOtpModel();
  const otp = loadOtp(Otp);

  const { code } = await otp.issueOtp({ email: 'a@b.c', purpose: 'reset' });
  const wrong = code === '000000' ? '111111' : '000000';

  for (let i = 0; i < 4; i++) await otp.verifyOtp({ email: 'a@b.c', purpose: 'reset', code: wrong });
  const last = await otp.verifyOtp({ email: 'a@b.c', purpose: 'reset', code: wrong });

  assert.equal(last.reason, 'exhausted');
  assert.equal(Otp.rows.length, 0, 'the code must be gone, not merely locked');
  // And the real code is dead with it — the budget is per code, not per guess-session.
  assert.equal((await otp.verifyOtp({ email: 'a@b.c', purpose: 'reset', code })).ok, false);
});

test('no outstanding code reads as an invalid one', async () => {
  const Otp = fakeOtpModel();
  const otp = loadOtp(Otp);

  const result = await otp.verifyOtp({ email: 'nobody@b.c', purpose: 'signup', code: '123456' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid');
});

test('two simultaneous verifications of the same code cannot both win', async () => {
  // The claim is decided by the database: findOneAndUpdate filters on consumedAt, so the second
  // update matches nothing. Simulated here by the row being consumed underneath.
  const Otp = fakeOtpModel();
  const otp = loadOtp(Otp);

  const { code } = await otp.issueOtp({ email: 'a@b.c', purpose: 'signup', payload: { passwordHash: 'h' } });
  const realFind = Otp.findOneAndUpdate.bind(Otp);
  let claims = 0;
  Otp.findOneAndUpdate = async (filter, update) => { claims++; return realFind(filter, update); };

  const [a, b] = await Promise.all([
    otp.verifyOtp({ email: 'a@b.c', purpose: 'signup', code }),
    otp.verifyOtp({ email: 'a@b.c', purpose: 'signup', code }),
  ]);

  assert.equal(claims, 2, 'both requests must have reached the atomic claim');
  assert.equal([a.ok, b.ok].filter(Boolean).length, 1);
});

// --- utils/rateLimit.js ----------------------------------------------------------------------

function fakeRateLimitModel() {
  const docs = new Map();
  return {
    docs,
    async findOneAndUpdate({ key }, update) {
      const doc = docs.get(key) || { key, count: 0, expiresAt: update.$setOnInsert.expiresAt };
      doc.count += update.$inc.count;
      docs.set(key, doc);
      return doc;
    },
  };
}

const loadLimit = (RateLimit) => loadWithStubs('utils/rateLimit.js', { '../models/RateLimit': RateLimit });

test('the send limit allows its quota and then refuses with a wait', async () => {
  const RateLimit = fakeRateLimitModel();
  const { consume } = loadLimit(RateLimit);

  for (let i = 0; i < 5; i++) {
    assert.equal((await consume('otpSendPerEmail', 'a@b.c')).allowed, true, `send ${i + 1}`);
  }
  const sixth = await consume('otpSendPerEmail', 'a@b.c');
  assert.equal(sixth.allowed, false);
  assert.ok(sixth.retryAfterSeconds > 0, 'a refusal has to say when to come back');
});

test('limits are counted per subject, not globally', async () => {
  const RateLimit = fakeRateLimitModel();
  const { consume } = loadLimit(RateLimit);

  for (let i = 0; i < 5; i++) await consume('otpSendPerEmail', 'a@b.c');
  assert.equal((await consume('otpSendPerEmail', 'other@b.c')).allowed, true);
});

test('the resend cooldown is one per minute', async () => {
  const RateLimit = fakeRateLimitModel();
  const { consume } = loadLimit(RateLimit);

  assert.equal((await consume('otpResendCooldown', 'signup:a@b.c')).allowed, true);
  assert.equal((await consume('otpResendCooldown', 'signup:a@b.c')).allowed, false);
});

test('a missing subject is not treated as one shared bucket', async () => {
  // clientIp returns null behind a proxy that strips it. Counting every such request against the
  // key `otpSendPerIp:null:...` would lock out every user at once.
  const RateLimit = fakeRateLimitModel();
  const { consume } = loadLimit(RateLimit);

  for (let i = 0; i < 30; i++) {
    assert.equal((await consume('otpSendPerIp', null)).allowed, true);
  }
  assert.equal(RateLimit.docs.size, 0);
});

// --- the controller --------------------------------------------------------------------------

/**
 * Loads authController with the OTP helpers stubbed, recording what it asked for. `existing`
 * decides whether User.findOne answers with an account.
 */
function loadCtrl({ existing = null, limited = false, verify = null, pending = null, mailThrows = false } = {}) {
  const calls = { issued: [], mailed: [], created: null, updated: null, verified: null };
  const ctrl = loadWithStubs('controllers/authController.js', {
    '../models/User': {
      findOne: async () => existing,
      create: async (doc) => { calls.created = doc; return { ...doc, _id: 'u1', toObject: () => ({ ...doc, _id: 'u1' }) }; },
      findByIdAndUpdate: async (id, update) => { calls.updated = { id, update }; return existing; },
      updateOne: async () => ({ modifiedCount: 1 }),
    },
    '../models/Otp': { findOne: () => ({ sort: async () => pending }) },
    '../utils/otp': {
      issueOtp: async (args) => { calls.issued.push(args); return { code: '654321', expiresAt: new Date(), ttlMinutes: 10 }; },
      verifyOtp: async (args) => { calls.verified = args; return verify; },
      TTL_MINUTES: 10,
    },
    '../utils/rateLimit': {
      consume: async () => ({ allowed: !limited, retryAfterSeconds: limited ? 900 : 0 }),
      clientIp: () => '1.2.3.4',
    },
    '../utils/mailer': {
      sendOtpEmail: async (...args) => {
        if (mailThrows) throw new Error('smtp is down');
        calls.mailed.push(args);
      },
    },
    '../utils/tokens': {
      issueTokens: () => ({ token: 't', refreshToken: 'r' }),
      signAccessToken: () => 't',
      signRefreshToken: () => 'r',
    },
  });
  return { ctrl, calls };
}

const body = (b) => ({ body: b, ip: '1.2.3.4' });
const SIGNUP = { name: 'Ada', email: 'a@b.c', password: 'correct horse' };

test('signup mails a code and writes no user', async () => {
  const { ctrl, calls } = loadCtrl();
  const res = mockRes();

  await ctrl.signup(body(SIGNUP), res);

  assert.equal(calls.created, null, 'the account must not exist before the code is entered');
  assert.equal(calls.issued.length, 1);
  assert.equal(calls.mailed.length, 1);
  assert.equal(calls.mailed[0][2], 'signup');
  assert.equal(res.statusCode, null);
});

test('the pending signup carries a hash, never the password itself', async () => {
  const { ctrl, calls } = loadCtrl();
  await ctrl.signup(body(SIGNUP), mockRes());

  const { payload } = calls.issued[0];
  assert.equal(payload.name, 'Ada');
  assert.notEqual(payload.passwordHash, SIGNUP.password);
  assert.equal(await bcrypt.compare(SIGNUP.password, payload.passwordHash), true);
  assert.ok(!('password' in payload));
});

test('signing up with an address that already has an account looks exactly like a new one', async () => {
  // The one thing this endpoint must never answer is "is X registered here?". Same status, same
  // body — the only difference is the mail that is not sent.
  const fresh = loadCtrl();
  const taken = loadCtrl({ existing: { _id: 'u9', email: 'a@b.c' } });

  const freshRes = mockRes();
  const takenRes = mockRes();
  await fresh.ctrl.signup(body(SIGNUP), freshRes);
  await taken.ctrl.signup(body(SIGNUP), takenRes);

  assert.deepEqual(takenRes.body, freshRes.body);
  assert.equal(takenRes.statusCode, freshRes.statusCode);
  assert.equal(taken.calls.mailed.length, 0);
  assert.equal(taken.calls.issued.length, 0);
});

test('a rate-limited signup issues nothing and says when to come back', async () => {
  const { ctrl, calls } = loadCtrl({ limited: true });
  const res = mockRes();

  await ctrl.signup(body(SIGNUP), res);

  assert.equal(res.statusCode, 429);
  assert.equal(res.body.retryAfter, 900);
  assert.equal(calls.issued.length, 0);
});

test('signup fails loudly when the mail cannot be sent', async () => {
  // The old flow mailed the link in the background because the account already existed to fall
  // back on. There is no account now, so a silent failure would leave the user waiting for a code
  // that is never coming.
  const { ctrl } = loadCtrl({ mailThrows: true });
  const res = mockRes();

  await ctrl.signup(body(SIGNUP), res);

  assert.equal(res.statusCode, 500);
});

test('a correct signup code creates the verified account and returns tokens', async () => {
  const { ctrl, calls } = loadCtrl({
    verify: { ok: true, payload: { name: 'Ada', passwordHash: 'hashed', timezone: 'Asia/Kolkata' } },
  });
  const res = mockRes();

  await ctrl.verifySignup(body({ email: 'a@b.c', code: '654321' }), res);

  assert.equal(calls.created.email, 'a@b.c');
  assert.equal(calls.created.password, 'hashed');
  assert.equal(calls.created.isEmailVerified, true);
  assert.equal(calls.created.timezone, 'Asia/Kolkata');
  assert.equal(res.body.token, 't');
  assert.equal(res.body.user.password, undefined, 'the hash must not travel back to the client');
});

test('a wrong signup code creates nothing and reports the attempts left', async () => {
  const { ctrl, calls } = loadCtrl({ verify: { ok: false, reason: 'invalid', attemptsLeft: 3 } });
  const res = mockRes();

  await ctrl.verifySignup(body({ email: 'a@b.c', code: '000000' }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.attemptsLeft, 3);
  assert.equal(calls.created, null);
});

test('an expired code and a spent one are told apart', async () => {
  const expired   = loadCtrl({ verify: { ok: false, reason: 'expired' } });
  const exhausted = loadCtrl({ verify: { ok: false, reason: 'exhausted' } });
  const a = mockRes();
  const b = mockRes();

  await expired.ctrl.verifySignup(body({ email: 'a@b.c', code: '000000' }), a);
  await exhausted.ctrl.verifySignup(body({ email: 'a@b.c', code: '000000' }), b);

  assert.match(a.body.message, /expired/i);
  assert.match(b.body.message, /wrong attempts/i);
});

test('a code that wins the race to an address already taken is refused, not thrown', async () => {
  const { ctrl, calls } = loadCtrl({
    existing: { _id: 'u9' },
    verify: { ok: true, payload: { name: 'Ada', passwordHash: 'hashed' } },
  });
  const res = mockRes();

  await ctrl.verifySignup(body({ email: 'a@b.c', code: '654321' }), res);

  assert.equal(res.statusCode, 409);
  assert.equal(calls.created, null);
});

test('forgot-password answers the same for a known and an unknown address', async () => {
  const known   = loadCtrl({ existing: { _id: 'u1', email: 'a@b.c' } });
  const unknown = loadCtrl();
  const a = mockRes();
  const b = mockRes();

  await known.ctrl.forgotPassword(body({ email: 'a@b.c' }), a);
  await unknown.ctrl.forgotPassword(body({ email: 'a@b.c' }), b);

  assert.deepEqual(b.body, a.body);
  assert.equal(known.calls.mailed[0][2], 'reset');
  assert.equal(unknown.calls.mailed.length, 0);
});

test('a reset with a correct code sets the password and kills every live session', async () => {
  const { ctrl, calls } = loadCtrl({ existing: { _id: 'u1' }, verify: { ok: true, payload: null } });
  const res = mockRes();

  await ctrl.resetPassword(body({ email: 'a@b.c', code: '654321', password: 'a new one' }), res);

  assert.equal(calls.verified.purpose, 'reset');
  assert.equal(calls.updated.update.$inc.tokenVersion, 1);
  assert.equal(await bcrypt.compare('a new one', calls.updated.update.$set.password), true);
});

test('a reset with a wrong code writes nothing', async () => {
  const { ctrl, calls } = loadCtrl({ existing: { _id: 'u1' }, verify: { ok: false, reason: 'invalid', attemptsLeft: 2 } });
  const res = mockRes();

  await ctrl.resetPassword(body({ email: 'a@b.c', code: '000000', password: 'a new one' }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(calls.updated, null);
});

test('resending a signup code reuses the pending account rather than losing it', async () => {
  // The app only has the address on the verify screen — the form is behind it. If a resend issued
  // an empty payload, the code that arrived would verify and then create nothing.
  const payload = { name: 'Ada', passwordHash: 'hashed', timezone: 'UTC' };
  const { ctrl, calls } = loadCtrl({ pending: { payload } });
  const res = mockRes();

  await ctrl.resendOtp(body({ email: 'a@b.c', purpose: 'signup' }), res);

  assert.deepEqual(calls.issued[0].payload, payload);
  assert.equal(calls.mailed.length, 1);
});

test('resending with nothing pending mails nothing and still says nothing', async () => {
  const pendingCase = loadCtrl({ pending: { payload: { passwordHash: 'h' } } });
  const emptyCase   = loadCtrl({ pending: null });
  const a = mockRes();
  const b = mockRes();

  await pendingCase.ctrl.resendOtp(body({ email: 'a@b.c', purpose: 'signup' }), a);
  await emptyCase.ctrl.resendOtp(body({ email: 'a@b.c', purpose: 'signup' }), b);

  assert.deepEqual(b.body, a.body);
  assert.equal(emptyCase.calls.mailed.length, 0);
});

test('a resend inside the cooldown is refused before anything is sent', async () => {
  const { ctrl, calls } = loadCtrl({ limited: true, pending: { payload: { passwordHash: 'h' } } });
  const res = mockRes();

  await ctrl.resendOtp(body({ email: 'a@b.c', purpose: 'signup' }), res);

  assert.equal(res.statusCode, 429);
  assert.equal(calls.mailed.length, 0);
});
