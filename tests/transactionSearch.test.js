// W1-08 regression, against the real controller: getTransactions used to assign `query.$or`
// directly, which replaced buildScope's privacy clause. Any group member searching for anything
// saw every other member's private transactions.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWithStubs, mockRes } = require('./helpers/stubs');

/** Runs getTransactions (which owns the search path) and returns the filter it handed to Mongo. */
async function search(query, user) {
  let captured = null;
  const Transaction = {
    find: (q) => {
      captured = q;
      const chain = {
        sort: () => chain, skip: () => chain, limit: () => chain,
        populate: () => chain, lean: async () => [],
      };
      return chain;
    },
    countDocuments: async () => 0,
  };
  const ctrl = loadWithStubs('controllers/transactionController.js', {
    '../models/Transaction': Transaction,
    '../models/User': { findById: async () => user },
    '../models/Group': {},
    '../models/Account': {},
  });
  const res = mockRes();
  await ctrl.getTransactions({ query, user: { id: user._id } }, res);
  return { captured, res };
}

const member = { _id: 'u1', groupId: 'g1' };
const solo   = { _id: 'u1', groupId: null };

test('a group member searching keeps the privacy filter', async () => {
  const { captured, res } = await search({ search: 'coffee' }, member);
  assert.equal(res.statusCode, null, 'handler should not have errored');

  // The privacy clause must survive somewhere in the filter.
  assert.ok(JSON.stringify(captured).includes('isPrivate'),
    'private transactions of other members are exposed: ' + JSON.stringify(captured));

  // And it must be ANDed with the text match, not merged into one $or (which would make
  // "matches the text" enough on its own).
  assert.ok(Array.isArray(captured.$and), 'expected the two conditions under $and');
  assert.equal(captured.$and.length, 2);
  assert.equal(captured.$or, undefined, 'the top-level $or must be removed, not left alongside $and');

  const [privacy, textMatch] = captured.$and;
  assert.deepEqual(privacy, { $or: [{ isPrivate: { $ne: true } }, { userId: 'u1' }] });
  assert.equal(textMatch.$or.length, 2, 'note and category');
});

test('a group member with no search term still gets the privacy filter', async () => {
  const { captured } = await search({}, member);
  assert.deepEqual(captured.$or, [{ isPrivate: { $ne: true } }, { userId: 'u1' }]);
  assert.equal(captured.groupId, 'g1');
  assert.equal(captured.deletedAt, null);
});

test('a solo user searching is scoped to their own rows', async () => {
  const { captured } = await search({ search: 'coffee' }, solo);
  assert.equal(captured.userId, 'u1');
  assert.equal(captured.deletedAt, null);
  // No group means no privacy clause to preserve, so the text match may own $or outright.
  assert.equal(captured.$or.length, 2);
  assert.equal(captured.$and, undefined);
});

test('regex metacharacters in the search term are escaped', async () => {
  // An unescaped "(" was a 500, and ".*" scanned every row.
  const { captured, res } = await search({ search: 'a(b).*c' }, solo);
  assert.equal(res.statusCode, null);
  // Found by shape, not by position — the clauses are an unordered $or and note is only one
  // of two ways it can be built (see the blind index in W1-28).
  const noteClause = captured.$or.find((c) => c.note);
  assert.ok(noteClause, 'expected a note clause: ' + JSON.stringify(captured.$or));
  const pattern = noteClause.note.$regex;
  assert.equal(pattern, 'a\\(b\\)\\.\\*c');
});

test('soft-deleted transactions are excluded from search', async () => {
  const { captured } = await search({ search: 'x' }, member);
  assert.equal(captured.deletedAt, null);
});
