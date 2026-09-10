// W1-13 regression: settling and deleting a split were gated on group membership alone, so any
// member could clear anyone else's debt — including their own — or delete the split that recorded
// it. Both are now payer-only, matching what the app's UI has always assumed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWithStubs, mockRes } = require('./helpers/stubs');

const PAYER  = 'payer1';
const DEBTOR = 'debtor1';
const OTHER  = 'other1';
const GROUP  = 'group1';

function makeSplit(over = {}) {
  const split = {
    _id: 'split1',
    groupId: GROUP,
    paidBy: PAYER,
    splits: [{ userId: DEBTOR, settled: false, settledAt: null }],
    saved: false,
    deleted: false,
    async save() { this.saved = true; },
    async deleteOne() { this.deleted = true; },
    async populate() { return this; },
    ...over,
  };
  return split;
}

function load(split, { found = true } = {}) {
  const calls = { findOne: null };
  const ctrl = loadWithStubs('controllers/splitController.js', {
    '../models/Split': {
      findOne: async (q) => { calls.findOne = q; return found ? split : null; },
    },
    '../models/User': {
      findById: async (id) => ({ _id: id, groupId: GROUP }),
    },
  });
  return { ctrl, calls };
}

const req = (callerId, params = {}) => ({
  user: { id: callerId },
  params: { id: 'split1', ...params },
  app: { get: () => null },
});

test('the payer can settle a member', async () => {
  const split = makeSplit();
  const { ctrl } = load(split);
  const res = mockRes();
  await ctrl.settleSplit(req(PAYER, { userId: DEBTOR }), res);

  assert.equal(res.statusCode, null, JSON.stringify(res.body));
  assert.equal(split.splits[0].settled, true);
  assert.equal(split.saved, true);
});

test('a debtor cannot settle their own debt', async () => {
  const split = makeSplit();
  const { ctrl } = load(split);
  const res = mockRes();
  await ctrl.settleSplit(req(DEBTOR, { userId: DEBTOR }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(split.splits[0].settled, false, 'nothing may be written on a rejected settle');
  assert.equal(split.saved, false);
});

test('an unrelated group member cannot settle', async () => {
  const split = makeSplit();
  const { ctrl } = load(split);
  const res = mockRes();
  await ctrl.settleSplit(req(OTHER, { userId: DEBTOR }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(split.saved, false);
});

test('the payer settling a member who is not in the split gets a 404', async () => {
  const split = makeSplit();
  const { ctrl } = load(split);
  const res = mockRes();
  await ctrl.settleSplit(req(PAYER, { userId: 'stranger' }), res);

  assert.equal(res.statusCode, 404);
  assert.equal(split.saved, false);
});

test('a split in another group is not found at all', async () => {
  const { ctrl, calls } = load(null, { found: false });
  const res = mockRes();
  await ctrl.settleSplit(req(PAYER, { userId: DEBTOR }), res);

  assert.equal(res.statusCode, 404);
  // The group filter has to be part of the lookup, not a check afterwards.
  assert.equal(calls.findOne.groupId, GROUP);
});

test('a user with no group cannot settle anything', async () => {
  const ctrl = loadWithStubs('controllers/splitController.js', {
    '../models/Split': { findOne: async () => makeSplit() },
    '../models/User': { findById: async () => ({ _id: OTHER, groupId: null }) },
  });
  const res = mockRes();
  await ctrl.settleSplit(req(OTHER, { userId: DEBTOR }), res);
  assert.equal(res.statusCode, 400);
});

test('only the payer can delete a split', async () => {
  const split = makeSplit();
  const { ctrl } = load(split);
  const res = mockRes();
  await ctrl.deleteSplit(req(DEBTOR), res);

  assert.equal(res.statusCode, 403);
  assert.equal(split.deleted, false,
    'a debtor could otherwise wipe the record of their own unsettled debt');
});

test('the payer can delete their own split', async () => {
  const split = makeSplit();
  const { ctrl } = load(split);
  const res = mockRes();
  await ctrl.deleteSplit(req(PAYER), res);

  assert.equal(res.statusCode, null, JSON.stringify(res.body));
  assert.equal(split.deleted, true);
});

test('deleting looks the split up first rather than deleting by id', async () => {
  // It used to be findOneAndDelete, which left no chance to check the payer.
  const { ctrl, calls } = load(makeSplit());
  await ctrl.deleteSplit(req(PAYER), mockRes());
  assert.deepEqual(calls.findOne, { _id: 'split1', groupId: GROUP });
});
