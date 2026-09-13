// Tombstones are kept 30 days so every device can hear a row is gone, then hard-deleted (W3-12).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWithStubs } = require('./helpers/stubs');

test('purgeTombstones deletes only rows tombstoned more than 30 days ago, in every collection', async () => {
  const calls = {};
  const model = (name) => ({
    deleteMany: async (f) => { calls[name] = f; return { deletedCount: 2 }; },
  });
  const groupCalls = {};
  const { purgeTombstones, RETENTION_DAYS } = loadWithStubs('utils/tombstones.js', {
    '../models/Transaction': model('tx'), '../models/Budget': model('budget'), '../models/Account': model('account'),
    '../models/Goal': model('goal'), '../models/Trip': model('trip'),
    '../models/Group': { updateMany: async (f, u) => { groupCalls.filter = f; groupCalls.update = u; return { modifiedCount: 1 }; } },
  });

  const now = new Date('2026-09-13T00:05:00Z');
  const out = await purgeTombstones(now);
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86400000);

  for (const name of ['tx', 'budget', 'account', 'goal', 'trip']) {
    assert.deepEqual(calls[name], { deletedAt: { $ne: null, $lt: cutoff } }, name);
  }
  assert.deepEqual(groupCalls.update, { $pull: { categories: { deletedAt: { $ne: null, $lt: cutoff } } } });
  assert.deepEqual(out, { transactions: 2, budgets: 2, accounts: 2, goals: 2, trips: 2, groups: 1 });
});
