// W1-13 / W1-27, carried onto the trip model (W2-28).
//
// Settling and deleting a split were once gated on group membership alone, so any member could
// clear anyone else's debt — including their own — or delete the split that recorded it. Both
// became payer-only. A trip is the same record with many bills in it, so the same rules apply, with
// one deliberate difference: a split had exactly one creditor and a trip has as many creditors as
// it has payers, so confirming a payment follows the member who was paid rather than the owner.
//
// These tests run the shipped controller with its models stubbed, so what is pinned is the real
// code path rather than a paraphrase of it.

const test   = require('node:test');
const assert = require('node:assert/strict');
const { loadWithStubs, mockRes } = require('./helpers/stubs');

const OWNER  = 'owner1';
const DEBTOR = 'debtor1';
const OTHER  = 'other1';
const GROUP  = 'group1';

function makeTrip(over = {}) {
  return {
    _id:     'trip1',
    groupId: GROUP,
    ownerId: OWNER,
    name:    'Goa weekend',
    members: [
      { id: 'm-owner',  name: 'Owner',  userId: OWNER },
      { id: 'm-debtor', name: 'Debtor', userId: DEBTOR },
      { id: 'm-priya',  name: 'Priya',  userId: null },
    ],
    expenses: [
      { id: 'e-1', description: 'Dinner', amountMinor: 300000, paidById: 'm-owner',
        participantIds: ['m-owner', 'm-debtor', 'm-priya'], toObject() { return { ...this }; } },
    ],
    settlements: [],
    saved:   false,
    deleted: false,
    async save() { this.saved = true; },
    async deleteOne() { this.deleted = true; },
    async populate() { return this; },
    ...over,
  };
}

function load(trip, { found = true, groupId = GROUP } = {}) {
  const calls = { findOne: null };
  const ctrl = loadWithStubs('controllers/tripController.js', {
    '../models/Trip': {
      findOne: async (q) => { calls.findOne = q; return found ? trip : null; },
    },
    '../models/User': {
      findById: async (id) => ({ _id: id, name: 'Someone', groupId }),
    },
  });
  return { ctrl, calls };
}

const req = (callerId, { params = {}, body = {} } = {}) => ({
  user:   { id: callerId },
  params: { id: 'trip1', ...params },
  body,
  app:    { get: () => null },
});

// ── mutating the trip is owner-only ───────────────────────────────────────────

test('the owner can rename a trip', async () => {
  const trip = makeTrip();
  const { ctrl } = load(trip);
  const res = mockRes();
  await ctrl.updateTrip(req(OWNER, { body: { name: 'Goa, take two' } }), res);

  assert.equal(res.statusCode, null, JSON.stringify(res.body));
  assert.equal(trip.name, 'Goa, take two');
  assert.equal(trip.saved, true);
});

test('a member cannot rename someone else\'s trip', async () => {
  const trip = makeTrip();
  const { ctrl } = load(trip);
  const res = mockRes();
  await ctrl.updateTrip(req(DEBTOR, { body: { name: 'Not my trip' } }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(trip.name, 'Goa weekend', 'nothing may be written on a rejected edit');
  assert.equal(trip.saved, false);
});

test('only the owner can delete a trip', async () => {
  const trip = makeTrip();
  const { ctrl } = load(trip);
  const res = mockRes();
  await ctrl.deleteTrip(req(DEBTOR), res);

  assert.equal(res.statusCode, 403);
  assert.equal(trip.deleted, false,
    'a debtor could otherwise wipe the record of their own unsettled debt');
});

test('the owner can delete their own trip', async () => {
  const trip = makeTrip();
  const { ctrl } = load(trip);
  const res = mockRes();
  await ctrl.deleteTrip(req(OWNER), res);

  assert.equal(res.statusCode, null, JSON.stringify(res.body));
  assert.equal(trip.deleted, true);
});

test('deleting looks the trip up first rather than deleting by id', async () => {
  // `findOneAndDelete` would leave no chance to check the owner — the W1-13 shape of the bug.
  const { ctrl, calls } = load(makeTrip());
  await ctrl.deleteTrip(req(OWNER), mockRes());
  assert.deepEqual(calls.findOne, { _id: 'trip1', groupId: GROUP });
});

test('a member cannot add an expense to someone else\'s trip', async () => {
  const trip = makeTrip();
  const { ctrl } = load(trip);
  const res = mockRes();
  await ctrl.addExpense(req(DEBTOR, {
    body: { description: 'Drinks', amountMinor: 50000, paidById: 'm-debtor', participantIds: ['m-owner'] },
  }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(trip.expenses.length, 1);
});

test('a member cannot remove people from someone else\'s trip', async () => {
  const trip = makeTrip();
  const { ctrl } = load(trip);
  const res = mockRes();
  await ctrl.removeMember(req(DEBTOR, { params: { memberId: 'm-priya' } }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(trip.members.length, 3);
});

// ── group scope ───────────────────────────────────────────────────────────────

test('a trip in another group is not found at all', async () => {
  const { ctrl, calls } = load(null, { found: false });
  const res = mockRes();
  await ctrl.deleteTrip(req(OWNER), res);

  assert.equal(res.statusCode, 404);
  // The group filter has to be part of the lookup, not a check afterwards.
  assert.equal(calls.findOne.groupId, GROUP);
});

test('a user with no group cannot touch anything', async () => {
  const { ctrl } = load(makeTrip(), { groupId: null });
  const res = mockRes();
  await ctrl.updateTrip(req(OWNER, { body: { name: 'x' } }), res);
  assert.equal(res.statusCode, 400);
});

// ── expenses cannot name people who are not in the trip ───────────────────────

test('an expense paid by a stranger is rejected', async () => {
  const trip = makeTrip();
  const { ctrl } = load(trip);
  const res = mockRes();
  await ctrl.addExpense(req(OWNER, {
    body: { description: 'Drinks', amountMinor: 50000, paidById: 'm-nobody', participantIds: ['m-owner'] },
  }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(trip.expenses.length, 1);
});

test('an expense shared with a stranger is rejected', async () => {
  const trip = makeTrip();
  const { ctrl } = load(trip);
  const res = mockRes();
  await ctrl.addExpense(req(OWNER, {
    body: { description: 'Drinks', amountMinor: 50000, paidById: 'm-owner', participantIds: ['m-owner', 'm-nobody'] },
  }), res);

  assert.equal(res.statusCode, 400);
});

test('an expense with no participants is rejected', async () => {
  // It would contribute nothing to any balance and could never be settled.
  const trip = makeTrip();
  const { ctrl } = load(trip);
  const res = mockRes();
  await ctrl.addExpense(req(OWNER, {
    body: { description: 'Drinks', amountMinor: 50000, paidById: 'm-owner', participantIds: [] },
  }), res);

  assert.equal(res.statusCode, 400);
});

test('an amount is truncated to whole minor units, never carried as a float', async () => {
  // The split endpoint stored rupees as a float and compared totals to a 0.01 tolerance because it
  // knew they drifted. Integers are the whole reason that tolerance is gone.
  const trip = makeTrip();
  const { ctrl } = load(trip);
  await ctrl.addExpense(req(OWNER, {
    body: { description: 'Chai', amountMinor: 1234.7, paidById: 'm-owner', participantIds: ['m-owner', 'm-debtor'] },
  }), mockRes());

  assert.equal(trip.expenses.at(-1).amountMinor, 1234);
});

test('explicit shares are the whole truth and the total is derived from them', async () => {
  // `amountMinor` is ignored when `sharesMinor` is present: a declared total that disagrees with
  // its own shares is the one way balances could stop summing to zero.
  const trip = makeTrip();
  const { ctrl } = load(trip);
  const res = mockRes();
  await ctrl.addExpense(req(OWNER, {
    body: {
      description: 'Airport cab',
      amountMinor:  999999,
      paidById:     'm-owner',
      sharesMinor:  { 'm-owner': 40000, 'm-debtor': 60000 },
    },
  }), res);

  assert.equal(res.statusCode, null, JSON.stringify(res.body));
  const added = trip.expenses.at(-1);
  assert.equal(added.amountMinor, 100000, 'the total is the sum of the shares, not the claim');
  assert.deepEqual(added.participantIds, ['m-owner', 'm-debtor'],
    'the share keys are the participants');
});

// ── confirming a payment follows the person who was paid ──────────────────────

test('the member who was paid can record it', async () => {
  const trip = makeTrip();
  const { ctrl } = load(trip);
  const res = mockRes();
  await ctrl.addSettlement(req(DEBTOR, {
    body: { fromId: 'm-owner', toId: 'm-debtor', amountMinor: 50000 },
  }), res);

  assert.equal(res.statusCode, null, JSON.stringify(res.body));
  assert.equal(trip.settlements.length, 1);
  assert.equal(trip.settlements[0].recordedBy, DEBTOR);
});

test('the owner can record a payment to a member with no account', async () => {
  // Priya cannot confirm anything herself, so the authority falls back to the owner.
  const trip = makeTrip();
  const { ctrl } = load(trip);
  const res = mockRes();
  await ctrl.addSettlement(req(OWNER, {
    body: { fromId: 'm-debtor', toId: 'm-priya', amountMinor: 50000 },
  }), res);

  assert.equal(res.statusCode, null, JSON.stringify(res.body));
  assert.equal(trip.settlements.length, 1);
});

test('the owner cannot confirm a payment to a member who has an account', async () => {
  // The recipient can speak for themselves, so the owner may not speak for them: an owner clearing
  // another account-holder's credit without their say is the hole W1-13 closed. The code used to
  // let the owner through unconditionally while the comment above it said otherwise.
  const trip = makeTrip();
  const { ctrl } = load(trip);
  const res = mockRes();
  await ctrl.addSettlement(req(OWNER, {
    body: { fromId: 'm-priya', toId: 'm-debtor', amountMinor: 50000 },
  }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(trip.settlements.length, 0);
  assert.equal(trip.saved, false);
});

test('undoing a payment follows the same rule as recording it', async () => {
  const trip = makeTrip({
    settlements: [{ id: 's-1', fromId: 'm-priya', toId: 'm-debtor', amountMinor: 50000, recordedBy: DEBTOR }],
  });
  const { ctrl } = load(trip);

  const asOwner = mockRes();
  await ctrl.deleteSettlement(req(OWNER, { params: { settlementId: 's-1' } }), asOwner);
  assert.equal(asOwner.statusCode, 403, 'the owner is not the one who was paid');
  assert.equal(trip.settlements.length, 1);

  const asDebtor = mockRes();
  await ctrl.deleteSettlement(req(DEBTOR, { params: { settlementId: 's-1' } }), asDebtor);
  assert.equal(asDebtor.statusCode, null, JSON.stringify(asDebtor.body));
  assert.equal(trip.settlements.length, 0);
});

test('a debtor cannot declare their own debt paid', async () => {
  // The core of W1-13: the person who owes the money is the one person who must not be able to say
  // it arrived.
  const trip = makeTrip();
  const { ctrl } = load(trip);
  const res = mockRes();
  await ctrl.addSettlement(req(DEBTOR, {
    body: { fromId: 'm-debtor', toId: 'm-priya', amountMinor: 50000 },
  }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(trip.settlements.length, 0);
  assert.equal(trip.saved, false);
});

test('an unrelated group member cannot record a payment', async () => {
  const trip = makeTrip();
  const { ctrl } = load(trip);
  const res = mockRes();
  await ctrl.addSettlement(req(OTHER, {
    body: { fromId: 'm-debtor', toId: 'm-priya', amountMinor: 50000 },
  }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(trip.saved, false);
});

test('a payment naming someone outside the trip is a 404', async () => {
  const trip = makeTrip();
  const { ctrl } = load(trip);
  const res = mockRes();
  await ctrl.addSettlement(req(OWNER, {
    body: { fromId: 'm-owner', toId: 'm-stranger', amountMinor: 50000 },
  }), res);

  assert.equal(res.statusCode, 404);
  assert.equal(trip.saved, false);
});

test('a payment to oneself is rejected', async () => {
  const trip = makeTrip();
  const { ctrl } = load(trip);
  const res = mockRes();
  await ctrl.addSettlement(req(OWNER, {
    body: { fromId: 'm-owner', toId: 'm-owner', amountMinor: 50000 },
  }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(trip.settlements.length, 0);
});

test('a zero-amount payment is rejected', async () => {
  const trip = makeTrip();
  const { ctrl } = load(trip);
  const res = mockRes();
  await ctrl.addSettlement(req(OWNER, {
    body: { fromId: 'm-debtor', toId: 'm-owner', amountMinor: 0 },
  }), res);

  assert.equal(res.statusCode, 400);
});

// ── creating a trip: the self-member and linked members ───────────────────────

/** Loader for createTrip/addMember, which need `Trip.create` and the caller's `Group`. */
function loadCreate({ groupMembers = [OWNER, DEBTOR, OTHER], trip = null } = {}) {
  const calls = { created: null };
  const ctrl = loadWithStubs('controllers/tripController.js', {
    '../models/Trip': {
      create:  async (doc) => { calls.created = doc; return { ...doc, _id: 'trip-new', async populate() { return this; } }; },
      findOne: async () => trip,
    },
    '../models/User':  { findById: async (id) => ({ _id: id, name: 'Account Name', groupId: GROUP }) },
    '../models/Group': { findById: () => ({ lean: async () => ({ _id: GROUP, members: groupMembers }) }) },
  });
  return { ctrl, calls };
}

test('a synced guest trip keeps its self-member instead of gaining a second "you"', async () => {
  // syncService sends the guest's self-member with the account's id. If the server dropped it and
  // seeded its own, every expense that member paid for would point at an id no longer in the trip,
  // and the user would see themselves twice — once with every debt, once with none.
  const { ctrl, calls } = loadCreate();
  const res = mockRes();
  await ctrl.createTrip(req(OWNER, { body: {
    name: 'Manali', members: [
      { id: 'local-me',   name: 'You',  userId: OWNER },
      { id: 'local-raj',  name: 'Raj' },
    ],
  } }), res);

  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const ids = calls.created.members.map(m => m.id);
  assert.deepEqual(ids, ['local-me', 'local-raj'], 'the guest ids survive, and nothing is added');
  assert.equal(calls.created.members[0].userId, OWNER);
  assert.equal(calls.created.members[0].name, 'Account Name', 'the self-member takes the account name, not "You"');
  assert.equal(calls.created.members.filter(m => String(m.userId) === OWNER).length, 1, 'exactly one member is the creator');
});

test('with no self-member supplied the creator is still seeded first', async () => {
  const { ctrl, calls } = loadCreate();
  const res = mockRes();
  await ctrl.createTrip(req(OWNER, { body: { name: 'Manali', members: [{ name: 'Raj' }] } }), res);

  assert.equal(res.statusCode, 201);
  assert.equal(calls.created.members.length, 2);
  assert.equal(String(calls.created.members[0].userId), OWNER);
});

test('a member linked to someone outside the group is refused', async () => {
  // A member's userId is what the response populates a name and photo from, and what lets that
  // person act on the trip — so it must name someone in the caller's group, not any id at all.
  const { ctrl, calls } = loadCreate({ groupMembers: [OWNER, DEBTOR] });
  const res = mockRes();
  await ctrl.createTrip(req(OWNER, { body: {
    name: 'Manali', members: [{ name: 'Stranger', userId: 'someone-else' }],
  } }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(calls.created, null);
});

test('addMember refuses a userId from outside the group too', async () => {
  const trip = makeTrip();
  const { ctrl } = loadCreate({ groupMembers: [OWNER, DEBTOR], trip });
  const res = mockRes();
  await ctrl.addMember(req(OWNER, { body: { name: 'Stranger', userId: 'someone-else' } }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(trip.members.length, 3);
});
