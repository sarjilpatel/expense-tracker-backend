// W1-07 regression: the nightly purge deleted budgets by `{ groupId: user.groupId }`. For a group
// member that wiped every budget in the group they were leaving; for a solo user, whose groupId is
// null, it matched `{ groupId: null }` — every solo user's budgets in the database.
//
// This is the most destructive bug found in the audit and the least likely to be noticed, because
// it runs at 00:05 with no output.

const test   = require('node:test');
const assert = require('node:assert/strict');
const { loadServerCrons, jobFor } = require('./helpers/serverCron');
const { atTime } = require('./helpers/stubs');

const PURGE = '5 0 * * *';

/** Runs the purge job over `users` and records every model call it made. */
async function runPurge(users, nowIso = '2026-09-10T00:05:00Z') {
  const calls = [];
  const record = (model, op) => async (...args) => { calls.push({ model, op, args }); };

  const model = (name, extra = {}) => ({
    deleteMany: record(name, 'deleteMany'),
    updateMany: record(name, 'updateMany'),
    updateOne:  record(name, 'updateOne'),
    find:       async () => [],
    ...extra,
  });

  let userQuery = null;
  const models = {
    './models/User': model('User', {
      find: async (q) => { userQuery = q; return users; },
      findByIdAndDelete: async (id) => { calls.push({ model: 'User', op: 'findByIdAndDelete', args: [id] }); },
    }),
    './models/Transaction': model('Transaction'),
    './models/Goal':        model('Goal'),
    './models/Account':     model('Account'),
    './models/Budget':      model('Budget'),
    './models/Split':       model('Split'),
    './models/Group':       model('Group'),
  };

  const { jobs } = loadServerCrons(models);
  const fn = jobFor(jobs, PURGE);
  assert.ok(fn, 'the purge job must be scheduled');
  await atTime(nowIso, () => fn());

  return {
    calls,
    userQuery,
    /** The first call to `Model.op`, or undefined. */
    call: (m, op) => calls.find((c) => c.model === m && c.op === op),
    all:  (m) => calls.filter((c) => c.model === m),
  };
}

const member = { _id: 'u1', groupId: 'g1' };
const solo   = { _id: 'u2', groupId: null };

test('the purge job runs at 00:05', async () => {
  const { jobs } = loadServerCrons();
  assert.ok(jobFor(jobs, PURGE), 'expected a job on "5 0 * * *"');
});

test('only users past their grace period are purged', async () => {
  const { userQuery } = await runPurge([]);
  assert.equal(userQuery.pendingDeletion, true);
  assert.ok(userQuery.deletionScheduledAt.$lte, 'the scheduled date must gate the purge');
  // A user who cancelled or is still inside the 30 days must not be caught by the query.
  assert.equal(new Date(userQuery.deletionScheduledAt.$lte).toISOString(),
               '2026-09-10T00:05:00.000Z');
});

test('budgets are deleted by userId, never by groupId', async () => {
  // The whole point of this file.
  const { call } = await runPurge([member]);
  const budget = call('Budget', 'deleteMany');

  assert.ok(budget, 'budgets must be purged');
  assert.deepEqual(budget.args[0], { userId: 'u1' });
  assert.equal('groupId' in budget.args[0], false,
    'scoping by groupId deletes every other group member\'s budgets too');
});

test('a solo user\'s purge cannot match every other solo user', async () => {
  // `{ groupId: null }` is a real filter that matches every solo user in the collection.
  const { call } = await runPurge([solo]);
  const budget = call('Budget', 'deleteMany');

  assert.deepEqual(budget.args[0], { userId: 'u2' });
});

test('the owned collections are all scoped to the departing user', async () => {
  const { call } = await runPurge([member]);

  for (const m of ['Transaction', 'Goal', 'Account', 'Budget']) {
    const c = call(m, 'deleteMany');
    assert.ok(c, `${m} must be purged`);
    assert.deepEqual(c.args[0], { userId: 'u1' }, `${m} is scoped to the user`);
  }
});

test('the user is removed from splits they owe on, and their own splits deleted', async () => {
  const { call } = await runPurge([member]);

  const pull = call('Split', 'updateMany');
  assert.deepEqual(pull.args[0], { 'splits.userId': 'u1' });
  assert.deepEqual(pull.args[1], { $pull: { splits: { userId: 'u1' } } });

  const del = call('Split', 'deleteMany');
  assert.deepEqual(del.args[0], { paidBy: 'u1' });
});

test('a group member is pulled out of the group members array', async () => {
  const { call } = await runPurge([member]);
  const group = call('Group', 'updateOne');

  assert.deepEqual(group.args[0], { _id: 'g1' });
  assert.deepEqual(group.args[1], { $pull: { members: 'u1' } });
});

test('a solo user touches no group document at all', async () => {
  const { all } = await runPurge([solo]);
  assert.equal(all('Group').length, 0, 'there is no group to update, and no null id to write to');
});

test('the user record itself is deleted last', async () => {
  const { calls } = await runPurge([member]);
  const last = calls[calls.length - 1];

  assert.equal(last.op, 'findByIdAndDelete');
  assert.equal(last.args[0], 'u1');
});

test('one user failing does not abort the rest of the batch', async () => {
  // A partial purge is retried tomorrow; abandoning the batch means the users behind it are
  // never purged at all.
  const poison = { get _id() { throw new Error('corrupt row'); }, groupId: null };
  const { call } = await runPurge([poison, member]);

  assert.ok(call('Budget', 'deleteMany'), 'the second user must still be purged');
  assert.deepEqual(call('Budget', 'deleteMany').args[0], { userId: 'u1' });
});
