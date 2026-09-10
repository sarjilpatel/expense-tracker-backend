// W1-22: `authMiddleware` logged every failed verification with `console.error`. Access tokens live
// one hour, so every active client generated one of those lines every hour forever — and it was the
// only thing in the backend that logged unconditionally, while `server.js` gates its own logging
// behind NODE_ENV. In production the useful signal drowned in expiries.
//
// The distinction now made: an expired token is the ordinary end of a session and is silent in
// production; a malformed or wrongly-signed one is someone tampering and keeps its line.

const test   = require('node:test');
const assert = require('node:assert/strict');
const jwt    = require('jsonwebtoken');
const authMiddleware = require('../middleware/authMiddleware');
const { mockRes } = require('./helpers/stubs');

const SECRET = 'x'.repeat(32);

/** Runs the middleware over one request and returns what it did, including anything it logged. */
function run(authorization, { nodeEnv } = {}) {
  const prevEnv    = process.env.NODE_ENV;
  const prevSecret = process.env.JWT_SECRET;
  const realWarn   = console.warn;
  const realError  = console.error;

  const logs = [];
  console.warn  = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));

  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  process.env.JWT_SECRET = SECRET;

  const req  = { headers: { authorization }, method: 'GET', originalUrl: '/api/transactions' };
  const res  = mockRes();
  let nexted = false;

  try {
    authMiddleware(req, res, () => { nexted = true; });
    return { req, res, nexted, logs };
  } finally {
    console.warn  = realWarn;
    console.error = realError;
    if (prevEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevEnv;
    if (prevSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prevSecret;
  }
}

const sign = (payload, opts = {}) => jwt.sign(payload, SECRET, { expiresIn: '1h', ...opts });

test('an expired token is silent in production', async () => {
  // The whole point. One line per client per hour, forever, for a thing that is working correctly.
  const expired = sign({ id: 'u1' }, { expiresIn: '-1s' });
  const { logs, res } = run(`Bearer ${expired}`, { nodeEnv: 'production' });

  assert.deepEqual(logs, [], `expected no log, got: ${JSON.stringify(logs)}`);
  assert.equal(res.statusCode, 401, 'the client is still rejected — only the logging changed');
});

test('an expired token still logs in development', async () => {
  // Locally it is exactly the thing you want to see when a request unexpectedly 401s.
  const expired = sign({ id: 'u1' }, { expiresIn: '-1s' });
  const { logs } = run(`Bearer ${expired}`, { nodeEnv: 'development' });

  assert.equal(logs.length, 1);
  assert.match(logs[0], /TokenExpiredError/);
});

test('an unset NODE_ENV is treated as development', async () => {
  const expired = sign({ id: 'u1' }, { expiresIn: '-1s' });
  const { logs } = run(`Bearer ${expired}`);
  assert.equal(logs.length, 1);
});

test('a wrongly-signed token is logged even in production', async () => {
  // Not routine, and the only thing here worth waking up for.
  const forged = jwt.sign({ id: 'u1' }, 'y'.repeat(32), { expiresIn: '1h' });
  const { logs, res } = run(`Bearer ${forged}`, { nodeEnv: 'production' });

  assert.equal(logs.length, 1, 'silencing this would hide an active forgery attempt');
  assert.match(logs[0], /JsonWebTokenError/);
  assert.equal(res.statusCode, 401);
});

test('a malformed token is logged in production too', async () => {
  const { logs } = run('Bearer not-a-jwt', { nodeEnv: 'production' });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /JsonWebTokenError/);
});

test('the token itself is never written to the log', async () => {
  // It is a live credential until it expires, and logs travel further than the process does.
  const forged = jwt.sign({ id: 'u1' }, 'y'.repeat(32), { expiresIn: '1h' });
  const { logs } = run(`Bearer ${forged}`, { nodeEnv: 'production' });

  assert.equal(logs.join(' ').includes(forged), false);
  assert.equal(logs.join(' ').includes(forged.split('.')[2]), false, 'not even the signature');
});

test('the log names the request that failed', async () => {
  // A bare error name with no route is not actionable.
  const { logs } = run('Bearer not-a-jwt', { nodeEnv: 'production' });
  assert.match(logs[0], /GET \/api\/transactions/);
});

test('a valid token passes through and populates req.user', async () => {
  const { req, nexted, res, logs } = run(`Bearer ${sign({ id: 'u1', groupId: 'g1' })}`);

  assert.equal(nexted, true);
  assert.equal(req.user.id, 'u1');
  assert.equal(req.user.groupId, 'g1');
  assert.equal(res.statusCode, null, 'a valid request must not be answered here');
  assert.deepEqual(logs, []);
});

test('a bare token without the Bearer prefix is still accepted', async () => {
  const { nexted, req } = run(sign({ id: 'u1' }));
  assert.equal(nexted, true);
  assert.equal(req.user.id, 'u1');
});

test('a missing header is a 401 and never reaches jwt.verify', async () => {
  const { res, nexted, logs } = run(undefined, { nodeEnv: 'production' });

  assert.equal(nexted, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { msg: 'No authorization token' });
  assert.deepEqual(logs, [], 'an anonymous request is not an error worth logging');
});

test('the 401 body does not tell the client which failure it was', async () => {
  // "expired" vs "invalid signature" is a free oracle for anyone probing tokens.
  const expired = sign({ id: 'u1' }, { expiresIn: '-1s' });
  const forged  = jwt.sign({ id: 'u1' }, 'y'.repeat(32), { expiresIn: '1h' });

  assert.deepEqual(run(`Bearer ${expired}`).res.body, { msg: 'Invalid or expired token' });
  assert.deepEqual(run(`Bearer ${forged}`).res.body,  { msg: 'Invalid or expired token' });
});
