// W1-29 regression: settling was one-way. `PATCH /splits/:id/settle/:userId` set `settled: true`
// and no route ever set it back, so a payer who tapped Mark Paid on the wrong member's row could
// only fix it by deleting the whole split and re-entering it — losing every other member's state
// with it. W1-13 made settling payer-only, which sharpened the problem: the payer became the only
// person who *could* fix it, and was the one person with no way to.
//
// `DELETE /splits/:id/settle/:userId` undoes it, under exactly the same rules as settling. Both
// handlers run through one `setSettled` helper, so what these tests really pin is that the rules
// cannot drift apart the way the two purge paths did in W1-27.

const test   = require('node:test');
const assert = require('node:assert/strict');
const { loadWithStubs, mockRes } = require('./helpers/stubs');

const PAYER  = 'payer1';
const DEBTOR = 'debtor1';
const OTHER  = 'other1';
const GROUP  = 'group1';

function makeSplit(over = {}) {
  return {
    _id: 'split1',
    groupId: GROUP,
    paidBy: PAYER,
    splits: [
      { userId: DEBTOR, settled: true,  settledAt: new Date('2026-09-01T00:00:00Z') },
      // The payer's own share, settled at creation because they cannot owe themselves.
      { userId: PAYER,  settled: true,  settledAt: new Date('2026-09-01T00:00:00Z') },
    ],
    saved: false,
    async save() { this.saved = true; },
    async deleteOne() { this.deleted = true; },
    async populate() { return this; },
    ...over,
  };
}

function load(split, { found = true } = {}) {
  const calls = { findOne: null };
  const ctrl = loadWithStubs('controllers/splitController.js', {
    '../models/Split': {
      findOne: async (q) => { calls.findOne = q; return found ? split : null; },
    },
    '../models/User': { findById: async (id) => ({ _id: id, groupId: GROUP }) },
  });
  return { ctrl, calls };
}

const req = (callerId, params = {}) => ({
  user: { id: callerId },
  params: { id: 'split1', ...params },
  app: { get: () => null },
});

const entryFor = (split, userId) => split.splits.find((s) => s.userId === userId);

test('the payer can undo a settle', async () => {
  const split = makeSplit();
  const { ctrl } = load(split);
  const res = mockRes();
  await ctrl.unsettleSplit(req(PAYER, { userId: DEBTOR }), res);

  assert.equal(res.statusCode, null, JSON.stringify(res.body));
  assert.equal(entryFor(split, DEBTOR).settled, false);
  assert.equal(split.saved, true);
});

test('the settlement timestamp is cleared, not left behind', async () => {
  // A row reading `settled: false` with a settledAt date is a lie about what happened, and the
  // date is what any later "when was this paid" question would read.
  const split = makeSplit();
  const { ctrl } = load(split);
  await ctrl.unsettleSplit(req(PAYER, { userId: DEBTOR }), mockRes());

  assert.equal(entryFor(split, DEBTOR).settledAt, null);
});

test('a debtor cannot un-settle their own debt back into existence', async () => {
  // The mirror of W1-13: if settling is payer-only, so is reversing it — otherwise a debtor cannot
  // clear a debt but can restore one the payer already cleared.
  const split = makeSplit();
  const { ctrl } = load(split);
  const res = mockRes();
  await ctrl.unsettleSplit(req(DEBTOR, { userId: DEBTOR }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(entryFor(split, DEBTOR).settled, true, 'nothing may be written on a rejected undo');
  assert.equal(split.saved, false);
});

test('an unrelated group member cannot un-settle', async () => {
  const split = makeSplit();
  const { ctrl } = load(split);
  const res = mockRes();
  await ctrl.unsettleSplit(req(OTHER, { userId: DEBTOR }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(split.saved, false);
});

test("the payer's own share cannot be marked unpaid", async () => {
  // It is settled at creation for a reason: the split would otherwise show its own author as
  // owing themselves money, in a state nothing else in the app can produce or clear.
  const split = makeSplit();
  const { ctrl } = load(split);
  const res = mockRes();
  await ctrl.unsettleSplit(req(PAYER, { userId: PAYER }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(entryFor(split, PAYER).settled, true);
  assert.equal(split.saved, false);
});

test('un-settling a member who is not in the split is a 404', async () => {
  const split = makeSplit();
  const { ctrl } = load(split);
  const res = mockRes();
  await ctrl.unsettleSplit(req(PAYER, { userId: 'stranger' }), res);

  assert.equal(res.statusCode, 404);
  assert.equal(split.saved, false);
});

test('a split in another group is not found at all', async () => {
  const { ctrl, calls } = load(null, { found: false });
  const res = mockRes();
  await ctrl.unsettleSplit(req(PAYER, { userId: DEBTOR }), res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(calls.findOne, { _id: 'split1', groupId: GROUP },
    'the group filter has to be part of the lookup, not a check afterwards');
});

test('a user with no group cannot un-settle anything', async () => {
  const ctrl = loadWithStubs('controllers/splitController.js', {
    '../models/Split': { findOne: async () => makeSplit() },
    '../models/User': { findById: async () => ({ _id: PAYER, groupId: null }) },
  });
  const res = mockRes();
  await ctrl.unsettleSplit(req(PAYER, { userId: DEBTOR }), res);
  assert.equal(res.statusCode, 400);
});

test('un-settling an already-unsettled member is a no-op that still succeeds', async () => {
  // Two taps of Undo, or a retry after a dropped response, must not be an error — the caller
  // asked for a state, not a transition.
  const split = makeSplit({
    splits: [{ userId: DEBTOR, settled: false, settledAt: null }],
  });
  const { ctrl } = load(split);
  const res = mockRes();
  await ctrl.unsettleSplit(req(PAYER, { userId: DEBTOR }), res);

  assert.equal(res.statusCode, null);
  assert.equal(entryFor(split, DEBTOR).settled, false);
});

test('the round trip leaves the entry exactly as it started', async () => {
  const split = makeSplit({ splits: [{ userId: DEBTOR, settled: false, settledAt: null }] });
  const { ctrl } = load(split);

  await ctrl.settleSplit(req(PAYER, { userId: DEBTOR }), mockRes());
  assert.equal(entryFor(split, DEBTOR).settled, true);
  assert.ok(entryFor(split, DEBTOR).settledAt instanceof Date);

  await ctrl.unsettleSplit(req(PAYER, { userId: DEBTOR }), mockRes());
  assert.deepEqual(
    { settled: entryFor(split, DEBTOR).settled, settledAt: entryFor(split, DEBTOR).settledAt },
    { settled: false, settledAt: null },
  );
});

test('un-settling tells the group, so other devices stop showing it as paid', async () => {
  // A split is shared state; a member looking at a stale "paid" row is the bug this undo exists
  // to fix, one screen further along.
  const split = makeSplit();
  const emitted = [];
  const { ctrl } = load(split);
  const request = req(PAYER, { userId: DEBTOR });
  request.app = { get: () => ({ to: (room) => ({ emit: (ev, payload) => emitted.push({ room, ev, payload }) }) }) };

  await ctrl.unsettleSplit(request, mockRes());

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].room, GROUP);
  assert.equal(emitted[0].ev, 'split_updated');
});

test('the settle route still behaves exactly as W1-13 left it', async () => {
  // The two handlers now share one body; this is the check that sharing it changed nothing.
  const split = makeSplit({ splits: [{ userId: DEBTOR, settled: false, settledAt: null }] });
  const { ctrl } = load(split);

  const denied = mockRes();
  await ctrl.settleSplit(req(DEBTOR, { userId: DEBTOR }), denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(split.saved, false);

  const allowed = mockRes();
  await ctrl.settleSplit(req(PAYER, { userId: DEBTOR }), allowed);
  assert.equal(allowed.statusCode, null);
  assert.equal(entryFor(split, DEBTOR).settled, true);
});
