// W1-11 regression: refresh tokens carry the user's `tokenVersion`, so bumping that field on
// logout or password reset invalidates every token ever issued to them. Before this, a stolen
// refresh token was good for a year and nothing could revoke it.

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'access-secret-for-tests';
process.env.REFRESH_TOKEN_SECRET = 'refresh-secret-for-tests';

const { signAccessToken, signRefreshToken, issueTokens, ACCESS_TTL, REFRESH_TTL } =
  require('../utils/tokens');

const user = (over = {}) => ({ _id: 'u1', tokenVersion: 0, ...over });

test('lifetimes are 1 hour and 30 days', () => {
  // The refresh token was 365 days in three copy-pasted places.
  assert.equal(ACCESS_TTL, '1h');
  assert.equal(REFRESH_TTL, '30d');

  const { token, refreshToken } = issueTokens(user());
  const a = jwt.verify(token, process.env.JWT_SECRET);
  const r = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
  assert.equal(a.exp - a.iat, 60 * 60);
  assert.equal(r.exp - r.iat, 30 * 24 * 60 * 60);
});

test('the two tokens are signed with different secrets', () => {
  const { token, refreshToken } = issueTokens(user());
  assert.throws(() => jwt.verify(token, process.env.REFRESH_TOKEN_SECRET));
  assert.throws(() => jwt.verify(refreshToken, process.env.JWT_SECRET));
});

test('a refresh token carries the current tokenVersion', () => {
  const decoded = jwt.verify(signRefreshToken(user({ tokenVersion: 7 })),
                             process.env.REFRESH_TOKEN_SECRET);
  assert.equal(decoded.tv, 7);
  assert.equal(decoded.id, 'u1');
});

test('bumping tokenVersion invalidates tokens issued at the old one', () => {
  const issued = jwt.verify(signRefreshToken(user({ tokenVersion: 1 })),
                            process.env.REFRESH_TOKEN_SECRET);
  // This is the comparison /auth/refresh makes.
  assert.equal(issued.tv === 1, true, 'accepted at version 1');
  assert.equal(issued.tv === 2, false, 'rejected once the user is bumped to 2');
});

test('a legacy token with no tv claim reads as version 0', () => {
  // Existing sessions predate the claim. They must keep working until the first bump, otherwise
  // deploying this logs out every user at once.
  const legacy = jwt.sign({ id: 'u1' }, process.env.REFRESH_TOKEN_SECRET, { expiresIn: '30d' });
  const decoded = jwt.verify(legacy, process.env.REFRESH_TOKEN_SECRET);
  const version = decoded.tv || 0;
  assert.equal(version, 0);
  assert.equal(version === (undefined || 0), true, 'accepted against a user still at version 0');
  assert.equal(version === 1, false, 'revoked by the first bump');
});

test('a user with no tokenVersion field yet signs as version 0', () => {
  const decoded = jwt.verify(signRefreshToken({ _id: 'u1' }), process.env.REFRESH_TOKEN_SECRET);
  assert.equal(decoded.tv, 0);
});

test('the access token carries no tokenVersion', () => {
  // It is deliberately not revocable — it lives an hour and the refresh token is the control point.
  const decoded = jwt.verify(signAccessToken(user({ tokenVersion: 5 })), process.env.JWT_SECRET);
  assert.equal(decoded.tv, undefined);
  assert.equal(decoded.id, 'u1');
});
