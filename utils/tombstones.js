const Transaction = require('../models/Transaction');
const Budget      = require('../models/Budget');
const Account     = require('../models/Account');
const Goal        = require('../models/Goal');
const Trip        = require('../models/Trip');
const Group       = require('../models/Group');

const RETENTION_DAYS = 30;

/**
 * Hard-delete tombstones older than the retention window (W3-12). A tombstone exists so that
 * every device can hear a row is gone; after 30 days a device that has not synced is doing a
 * full pull anyway (its cursor is older than anything the feed would page), so the row can go.
 * Transactions' 30 days double as the undo window `restoreTransaction` already relied on.
 */
async function purgeTombstones(now = new Date()) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const gone = { deletedAt: { $ne: null, $lt: cutoff } };
  const [tx, budgets, accounts, goals, trips] = await Promise.all([
    Transaction.deleteMany(gone), Budget.deleteMany(gone), Account.deleteMany(gone),
    Goal.deleteMany(gone), Trip.deleteMany(gone),
  ]);
  const categories = await Group.updateMany(
    { 'categories.deletedAt': { $ne: null, $lt: cutoff } },
    { $pull: { categories: { deletedAt: { $ne: null, $lt: cutoff } } } },
  );
  return {
    transactions: tx.deletedCount, budgets: budgets.deletedCount, accounts: accounts.deletedCount,
    goals: goals.deletedCount, trips: trips.deletedCount, groups: categories.modifiedCount,
  };
}

module.exports = { purgeTombstones, RETENTION_DAYS };
