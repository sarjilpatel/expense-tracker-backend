// W1-27 regression: the two account-deletion paths disagreed about who owns a shared bill.
//
// The nightly purge cron had it right — detach the departing user from records others own, delete
// only the ones they own themselves. `authController.deleteAllData`, the immediate "Full Reset"
// endpoint, instead ran:
//
//     Split.deleteMany({ $or: [{ paidBy: userId }, { 'splits.userId': userId }] })
//
// so one member resetting their own account destroyed every split they had merely *participated*
// in — records belonging to whoever paid, which the rest of the group still needed to settle
// against. Nothing warned anyone; the debts simply vanished from other people's screens.
//
// Splits became trips in W2-28 and the rule survived the model change, but the *shape* of the
// detach did not: a trip member carries their own name and may have no account at all, so losing
// the account costs the link and nothing else. Pulling the member out of the trip would silently
// rewrite every remaining balance, which is the same class of damage the original bug did.
//
// Both callers now share `utils/purgeUser.js`. These tests run the real helper, and the controller
// test runs the real controller through it, because the bug was never in the helper — it was in
// one of two copies of the same list.

const test   = require('node:test');
const assert = require('node:assert/strict');
const { loadWithStubs, mockRes } = require('./helpers/stubs');

/** Model stubs that record every call, keyed by the `../models/X` spelling both files use. */
function recorder({ user } = {}) {
  const calls = [];
  const record = (model, op) => async (...args) => { calls.push({ model, op, args }); };

  const model = (name, extra = {}) => ({
    deleteMany: record(name, 'deleteMany'),
    updateMany: record(name, 'updateMany'),
    updateOne:  record(name, 'updateOne'),
    ...extra,
  });

  const stubs = {
    '../models/User': model('User', {
      findById: async () => user,
      findByIdAndDelete: async (id) => { calls.push({ model: 'User', op: 'findByIdAndDelete', args: [id] }); },
    }),
    '../models/Transaction': model('Transaction'),
    '../models/Goal':        model('Goal'),
    '../models/Account':     model('Account'),
    '../models/Budget':      model('Budget'),
    '../models/Trip':        model('Trip'),
    '../models/Group':       model('Group'),
  };

  return {
    stubs,
    calls,
    call: (m, op) => calls.find((c) => c.model === m && c.op === op),
    all:  (m) => calls.filter((c) => c.model === m),
  };
}

const member = { _id: 'u1', groupId: 'g1' };
const solo   = { _id: 'u2', groupId: null };

/** Runs the shared helper directly. */
async function runPurge(user) {
  const rec = recorder({ user });
  const { purgeUser } = loadWithStubs('utils/purgeUser.js', rec.stubs);
  await purgeUser(user);
  return rec;
}

/** Runs the real `deleteAllData` endpoint, which reaches the real helper. */
async function runEndpoint(user) {
  const rec = recorder({ user });
  const controller = loadWithStubs('controllers/authController.js', rec.stubs,
    { also: ['utils/purgeUser.js'] });

  const res = mockRes();
  await controller.deleteAllData({ user: { id: user ? user._id : 'gone' } }, res);
  return { ...rec, res };
}

// ── The bug ───────────────────────────────────────────────────────────────────

test('a trip the user is only a member of is edited, not deleted', async () => {
  // The whole point of this file. Deleting it takes the owner's record with it.
  const { call } = await runPurge(member);

  const unlink = call('Trip', 'updateMany');
  assert.ok(unlink, 'the user must be detached from trips they are a member of');
  assert.deepEqual(unlink.args[0], { 'members.userId': 'u1' });
  assert.deepEqual(unlink.args[1], { $set: { 'members.$[m].userId': null } });
  assert.deepEqual(unlink.args[2], { arrayFilters: [{ 'm.userId': 'u1' }] });
});

test('the member survives the account, under their own name', async () => {
  // A $pull here would be the W1-27 bug wearing the new model's clothes: the expenses that member
  // paid for or shared would lose their payer and their participants, and every other balance in
  // the trip would change without anyone having touched it.
  const { all } = await runPurge(member);

  for (const c of all('Trip').filter((x) => x.op === 'updateMany')) {
    const update = JSON.stringify(c.args[1]);
    assert.equal(update.includes('$pull'), false,
      `removing the member rewrites every other balance in the trip: ${update}`);
  }
});

test('only trips the user owns are deleted', async () => {
  const { call } = await runPurge(member);

  const del = call('Trip', 'deleteMany');
  assert.ok(del, 'trips the user owns must still go');
  assert.deepEqual(del.args[0], { ownerId: 'u1' },
    'anything wider than ownerId destroys another member\'s record');
});

test('no trip delete matches on membership', async () => {
  // The exact shape of the old bug: `$or: [{ paidBy }, { "splits.userId" }]`.
  const { all } = await runPurge(member);

  for (const c of all('Trip').filter((x) => x.op === 'deleteMany')) {
    const q = JSON.stringify(c.args[0]);
    assert.equal(q.includes('members.userId'), false,
      `a membership-matching delete is the W1-27 bug: ${q}`);
    assert.equal(q.includes('$or'), false, `unexpected $or in a trip delete: ${q}`);
  }
});

test('the Full Reset endpoint clears trips the same way the cron does', async () => {
  // The bug lived here, not in the cron, and this is the path a user triggers by hand.
  const { call, res } = await runEndpoint(member);

  assert.deepEqual(call('Trip', 'updateMany').args[0], { 'members.userId': 'u1' });
  assert.deepEqual(call('Trip', 'deleteMany').args[0], { ownerId: 'u1' });
  assert.equal(res.statusCode, null, 'a successful reset answers 200 via res.json');
  assert.deepEqual(res.body, { message: 'All data deleted successfully' });
});

// ── Everything else the purge must still get right ───────────────────────────

test('the owned collections are all scoped to the departing user', async () => {
  const { call } = await runPurge(member);

  for (const m of ['Transaction', 'Goal', 'Account', 'Budget']) {
    const c = call(m, 'deleteMany');
    assert.ok(c, `${m} must be purged`);
    assert.deepEqual(c.args[0], { userId: 'u1' }, `${m} must be scoped by userId`);
  }
});

test('budgets are deleted by userId, never by groupId', async () => {
  // W1-07's bug, now inherited by both callers from one place — pinned here so the extraction
  // cannot quietly reintroduce it.
  const { call } = await runPurge(solo);

  const q = call('Budget', 'deleteMany').args[0];
  assert.deepEqual(q, { userId: 'u2' });
  assert.equal('groupId' in q, false,
    'a null groupId matches every solo user\'s budgets in the database');
});

test('a departing user is pulled out of every group they belong to', async () => {
  // Every group, not just `groupId` — a user holds membership in their personal group and any
  // number of shared ones, and only the active one is named on the user row.
  const { call } = await runPurge(member);

  const c = call('Group', 'updateMany');
  assert.ok(c, 'a departing member must leave their groups');
  assert.deepEqual(c.args[0], { members: 'u1' });
  assert.deepEqual(c.args[1], { $pull: { members: 'u1' } });
});

test('their personal group is deleted with them', async () => {
  // Every account owns one (W1-33). It has no join code and no other member, so once the owner is
  // gone nothing can ever reach it — leaving it is an orphan per deleted account, forever.
  const { call } = await runPurge(member);

  const c = call('Group', 'deleteMany');
  assert.ok(c, 'the personal group must not be left behind');
  assert.deepEqual(c.args[0], { owner: 'u1', isPersonal: true });
});

test('a solo user is handled by the same membership query, with no null id written', async () => {
  const { call, all } = await runPurge(solo);
  assert.equal(call('Group', 'updateOne'), undefined,
    'with groupId null, `{ _id: null }` is a query that can match the wrong thing');
  assert.ok(all('Group').every(c => !JSON.stringify(c.args).includes('null')),
    'no group query may carry a null id');
});

test('the user record itself is deleted last', async () => {
  // If the user row goes first and a later delete throws, the orphaned rows are unreachable —
  // nothing left to look them up by.
  const { calls } = await runPurge(member);

  const last = calls[calls.length - 1];
  assert.equal(last.model, 'User');
  assert.equal(last.op, 'findByIdAndDelete');
  assert.deepEqual(last.args, ['u1']);
});

test('the endpoint 404s for a user that is already gone', async () => {
  const { res, calls } = await runEndpoint(null);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(calls, [], 'nothing may be deleted when there is no user to delete it for');
});
