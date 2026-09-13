// W1-14 regression: accounts became a server-side domain. Every path that accepts an accountId
// has to prove the account belongs to the caller — a well-formed ObjectId is not evidence of
// anything — and deleting an account must not take the user's spending history with it.

const test   = require('node:test');
const assert = require('node:assert/strict');
const { loadWithStubs, mockRes } = require('./helpers/stubs');

const ME         = '507f1f77bcf86cd799439011';
const MY_ACC     = '507f191e810c19729de860ea';
const NOT_MY_ACC = '507f191e810c19729de860eb';
const TX         = '507f191e810c19729de860ec';

const OWNED = new Set([MY_ACC]);

function load({ mapRows = [], accountRows = [], txFound = true } = {}) {
  const seen = { exists: null, updateMany: null, findOneAndUpdate: null, tombstoned: null, created: [] };

  const Account = {
    exists: async (q) => {
      seen.exists = q;
      return q.userId === ME && OWNED.has(String(q._id)) ? { _id: q._id } : null;
    },
    // Deletion is a tombstone (W3-05): a scoped findOneAndUpdate setting deletedAt.
    findOneAndUpdate: async (q, update) => {
      seen.tombstoned = { filter: q, update };
      return q.userId === ME && OWNED.has(String(q._id)) ? { _id: q._id } : null;
    },
    find: () => ({ sort: () => ({ lean: async () => accountRows }) }),
    create: async (doc) => { seen.created.push(doc); return { ...doc, _id: MY_ACC, createdAt: new Date() }; },
  };

  const Transaction = {
    updateMany: async (filter, update) => { seen.updateMany = { filter, update }; return { modifiedCount: 3 }; },
    findOneAndUpdate: async (filter, update) => {
      seen.findOneAndUpdate = { filter, update };
      return txFound ? { _id: TX } : null;
    },
    find: () => ({ lean: async () => mapRows }),
  };

  const ctrl = loadWithStubs('controllers/accountController.js', {
    '../models/Account': Account,
    '../models/Transaction': Transaction,
  });
  return { ctrl, seen };
}

const req = (over = {}) => ({ user: { id: ME }, params: {}, body: {}, ...over });

test('a transaction can be filed under an account the caller owns', async () => {
  const { ctrl, seen } = load();
  const res = mockRes();
  await ctrl.setTxAccount(req({ params: { id: TX }, body: { accountId: MY_ACC } }), res);

  assert.equal(res.statusCode, null, JSON.stringify(res.body));
  assert.equal(seen.findOneAndUpdate.update.$set.accountId, MY_ACC);
  // The write is scoped to the caller as well, not just to the transaction id.
  assert.equal(seen.findOneAndUpdate.filter.userId, ME);
});

test('an account belonging to someone else is rejected, not silently accepted', async () => {
  const { ctrl, seen } = load();
  const res = mockRes();
  await ctrl.setTxAccount(req({ params: { id: TX }, body: { accountId: NOT_MY_ACC } }), res);

  assert.equal(res.statusCode, 404);
  assert.equal(seen.findOneAndUpdate, null, 'nothing may be written');
  // Ownership is proven by the query, not by comparing fields after the fact.
  assert.equal(seen.exists.userId, ME);
});

test('a malformed account id is a 400, not a cast error', async () => {
  const { ctrl, seen } = load();
  const res = mockRes();
  await ctrl.setTxAccount(req({ params: { id: TX }, body: { accountId: 'nope' } }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(seen.exists, null);
  assert.equal(seen.findOneAndUpdate, null);
});

test('a null accountId clears the link without an ownership check', async () => {
  const { ctrl, seen } = load();
  const res = mockRes();
  await ctrl.setTxAccount(req({ params: { id: TX }, body: { accountId: null } }), res);

  assert.equal(res.statusCode, null, JSON.stringify(res.body));
  assert.equal(seen.findOneAndUpdate.update.$set.accountId, null);
  assert.equal(res.body.accountId, null);
});

test('assigning an account to a transaction that is not yours is a 404', async () => {
  const { ctrl } = load({ txFound: false });
  const res = mockRes();
  await ctrl.setTxAccount(req({ params: { id: TX }, body: { accountId: MY_ACC } }), res);
  assert.equal(res.statusCode, 404);
});

test('deleting an account unassigns its transactions instead of deleting them', async () => {
  // They are real spending the user has already seen. Cascading the delete would silently
  // destroy history because a wallet was removed.
  const { ctrl, seen } = load();
  const res = mockRes();
  await ctrl.deleteAccount(req({ params: { id: MY_ACC } }), res);

  assert.equal(res.statusCode, null, JSON.stringify(res.body));
  assert.ok(seen.tombstoned.update.$set.deletedAt instanceof Date, 'the account is tombstoned, not removed');
  assert.deepEqual(seen.updateMany.update, { $set: { accountId: null } });
  assert.equal(seen.updateMany.filter.userId, ME);
  assert.equal(String(seen.updateMany.filter.accountId), MY_ACC);
});

test('deleting an account you do not own is a 404 and touches nothing', async () => {
  const { ctrl, seen } = load();
  const res = mockRes();
  await ctrl.deleteAccount(req({ params: { id: NOT_MY_ACC } }), res);

  assert.equal(res.statusCode, 404);
  assert.equal(seen.updateMany, null, 'someone else\'s transactions must not be unassigned');
  // The delete itself is scoped, so it can never remove another user's account.
  assert.equal(seen.tombstoned.filter.userId, ME);
});

test('the tx->account map only covers assigned rows', async () => {
  const { ctrl } = load({ mapRows: [{ _id: TX, accountId: MY_ACC }] });
  const res = mockRes();
  await ctrl.getTxAccountMap(req(), res);

  assert.deepEqual(res.body, { [TX]: MY_ACC });
});

test('accounts are shaped with both id and _id', async () => {
  // The app has always keyed accounts by `id`; the rest of the API returns `_id`. Sending both
  // keeps guest-mode data structurally identical to remote data.
  const { ctrl } = load({ accountRows: [{
    _id: MY_ACC, name: 'Wallet', type: 'cash', openingBalance: 0, color: '', icon: '',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  }] });
  const res = mockRes();
  await ctrl.getAccounts(req(), res);

  assert.equal(res.body[0].id, MY_ACC);
  assert.equal(res.body[0]._id, MY_ACC);
  assert.equal(res.body[0].name, 'Wallet');
});

test('an empty import is refused', async () => {
  const { ctrl } = load();
  const res = mockRes();
  await ctrl.importAccounts(req({ body: { accounts: [] } }), res);
  assert.equal(res.statusCode, 400);
});

test('an import is stamped with the caller and returns a guest-id map', async () => {
  // syncService rewrites its transaction->account links with idMap before importing the
  // transactions, so a missing entry silently orphans them.
  const { ctrl, seen } = load();
  const res = mockRes();
  await ctrl.importAccounts(req({ body: { accounts: [{ id: 'local-1', name: 'Wallet', type: 'cash' }] } }), res);

  assert.equal(res.statusCode, 201);
  assert.equal(seen.created[0].userId, ME);
  assert.equal(res.body.idMap['local-1'], MY_ACC);
});

test('an import over the cap is refused outright', async () => {
  const { ctrl, seen } = load();
  const res = mockRes();
  const accounts = Array.from({ length: 101 }, (_, i) => ({ id: String(i), name: 'A', type: 'cash' }));
  await ctrl.importAccounts(req({ body: { accounts } }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(seen.created.length, 0, 'nothing may be written when the batch is rejected');
});
