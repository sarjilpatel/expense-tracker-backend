// W1-29, carried onto the trip model (W2-28).
//
// Settling was one-way: `PATCH /splits/:id/settle/:userId` set `settled: true` and no route ever
// set it back, so a payer who tapped Mark Paid on the wrong member's row could only fix it by
// deleting the whole split and re-entering it — losing every other member's state with it. W1-13
// had made settling payer-only, which sharpened the problem: the payer became the only person who
// *could* fix it, and was the one person with no way to.
//
// A trip records a payment as a row rather than a flag, so undoing one is a DELETE of that row.
// That is the same conclusion W1-29 reached, arrived at in the model instead of in a second
// endpoint — and it is why the rules cannot drift apart the way the two purge paths did in W1-27:
// there is no second copy of them to drift.

const test   = require('node:test');
const assert = require('node:assert/strict');
const { loadWithStubs, mockRes } = require('./helpers/stubs');

const OWNER  = 'owner1';
const DEBTOR = 'debtor1';
const OTHER  = 'other1';
const GROUP  = 'group1';

function makeTrip(settlements) {
  return {
    _id:     'trip1',
    groupId: GROUP,
    ownerId: OWNER,
    members: [
      { id: 'm-owner',  name: 'Owner',  userId: OWNER },
      { id: 'm-debtor', name: 'Debtor', userId: DEBTOR },
      { id: 'm-priya',  name: 'Priya',  userId: null },
    ],
    expenses: [],
    settlements: settlements ?? [
      { id: 's-1', fromId: 'm-debtor', toId: 'm-owner', amountMinor: 50000, recordedBy: OWNER },
    ],
    saved: false,
    emitted: [],
    async save() { this.saved = true; },
    async populate() { return this; },
  };
}

function load(trip, { groupId = GROUP } = {}) {
  return loadWithStubs('controllers/tripController.js', {
    '../models/Trip': { findOne: async () => trip },
    '../models/User': { findById: async (id) => ({ _id: id, name: 'Someone', groupId }) },
  });
}

const req = (callerId, { params = {}, body = {}, io = null } = {}) => ({
  user:   { id: callerId },
  params: { id: 'trip1', settlementId: 's-1', ...params },
  body,
  app:    { get: () => io },
});

test('the member who was paid can undo it', async () => {
  const trip = makeTrip();
  const ctrl = load(trip);
  const res  = mockRes();
  await ctrl.deleteSettlement(req(OWNER), res);

  assert.equal(res.statusCode, null, JSON.stringify(res.body));
  assert.equal(trip.settlements.length, 0);
  assert.equal(trip.saved, true);
});

test('the payment is gone, not flagged', async () => {
  // A second boolean is how the original settle/unsettle pair drifted. There is nothing left
  // behind to disagree with.
  const trip = makeTrip();
  const ctrl = load(trip);
  await ctrl.deleteSettlement(req(OWNER), mockRes());

  assert.deepEqual(trip.settlements, []);
});

test('the debtor cannot un-pay themselves', async () => {
  // The mirror of W1-13: whoever cannot declare a debt paid cannot declare it unpaid either.
  const trip = makeTrip();
  const ctrl = load(trip);
  const res  = mockRes();
  await ctrl.deleteSettlement(req(DEBTOR), res);

  assert.equal(res.statusCode, 403);
  assert.equal(trip.settlements.length, 1);
  assert.equal(trip.saved, false);
});

test('an unrelated group member cannot undo a payment', async () => {
  const trip = makeTrip();
  const ctrl = load(trip);
  const res  = mockRes();
  await ctrl.deleteSettlement(req(OTHER), res);

  assert.equal(res.statusCode, 403);
  assert.equal(trip.saved, false);
});

test('the owner can undo a payment made to a member with no account', async () => {
  const trip = makeTrip([
    { id: 's-1', fromId: 'm-debtor', toId: 'm-priya', amountMinor: 50000, recordedBy: OWNER },
  ]);
  const ctrl = load(trip);
  const res  = mockRes();
  await ctrl.deleteSettlement(req(OWNER), res);

  assert.equal(res.statusCode, null, JSON.stringify(res.body));
  assert.equal(trip.settlements.length, 0);
});

test('undoing a payment that is not there is a 404', async () => {
  const trip = makeTrip();
  const ctrl = load(trip);
  const res  = mockRes();
  await ctrl.deleteSettlement(req(OWNER, { params: { settlementId: 's-gone' } }), res);

  assert.equal(res.statusCode, 404);
  assert.equal(trip.saved, false);
});

test('a user with no group cannot undo anything', async () => {
  const trip = makeTrip();
  const ctrl = load(trip, { groupId: null });
  const res  = mockRes();
  await ctrl.deleteSettlement(req(OWNER), res);

  assert.equal(res.statusCode, 400);
});

test('the round trip leaves the trip exactly as it started', async () => {
  const trip = makeTrip([]);
  const ctrl = load(trip);

  await ctrl.addSettlement(req(OWNER, {
    body: { fromId: 'm-debtor', toId: 'm-owner', amountMinor: 50000 },
  }), mockRes());
  assert.equal(trip.settlements.length, 1);

  const id = trip.settlements[0].id;
  await ctrl.deleteSettlement(req(OWNER, { params: { settlementId: id } }), mockRes());
  assert.deepEqual(trip.settlements, []);
});

test('undoing tells the group, so other devices stop showing it as paid', async () => {
  const emitted = [];
  const io = { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) };

  const trip = makeTrip();
  const ctrl = load(trip);
  await ctrl.deleteSettlement(req(OWNER, { io }), mockRes());

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].room, GROUP);
  assert.equal(emitted[0].event, 'trip_updated');
});

test('a rejected undo tells nobody anything', async () => {
  const emitted = [];
  const io = { to: () => ({ emit: (event) => emitted.push(event) }) };

  const trip = makeTrip();
  const ctrl = load(trip);
  await ctrl.deleteSettlement(req(DEBTOR, { io }), mockRes());

  assert.deepEqual(emitted, []);
});
