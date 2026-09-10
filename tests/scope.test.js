// Regression tests for the read-privacy filter (W1-08: searchTransactions replaced buildScope's
// `$or` instead of extending it, so any group member searching saw every other member's private
// transactions).

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildScope } = require('../utils/scope');

const solo   = { _id: 'u1', groupId: null };
const member = { _id: 'u1', groupId: 'g1' };

test('a solo user is scoped to their own rows', () => {
  assert.deepEqual(buildScope(solo), { userId: 'u1', deletedAt: null });
});

test('a group member is scoped to the group, minus other members private rows', () => {
  assert.deepEqual(buildScope(member), {
    groupId: 'g1',
    deletedAt: null,
    $or: [{ isPrivate: { $ne: true } }, { userId: 'u1' }],
  });
});

test('soft-deleted rows are excluded in both shapes', () => {
  // deleteTransaction is a soft delete; without this every scope leaks deleted rows back.
  assert.equal(buildScope(solo).deletedAt, null);
  assert.equal(buildScope(member).deletedAt, null);
});

test('a group scope never filters by userId at the top level', () => {
  // Doing so would hide the rest of the group's shared transactions.
  assert.equal('userId' in buildScope(member), false);
});

test('assigning $or over a group scope drops the privacy filter', () => {
  // This is the exact shape of the W1-08 bug — the later key wins and the privacy clause is gone.
  // The live fix moves both conditions under $and; that is pinned end-to-end in
  // transactionSearch.test.js. Kept here because it is the trap any future narrowing will fall in.
  const broken = { ...buildScope(member), $or: [{ note: /coffee/ }] };
  assert.equal(JSON.stringify(broken).includes('isPrivate'), false);
});

test('each call returns a fresh object', () => {
  // Six call sites spread and mutate the result; a shared object would leak between requests.
  const a = buildScope(member);
  const b = buildScope(member);
  assert.notEqual(a, b);
  a.groupId = 'tampered';
  assert.equal(b.groupId, 'g1');
});
