const mongoose    = require('mongoose');
const Account     = require('../models/Account');
const Transaction = require('../models/Transaction');

// The app has always shaped accounts with an `id` field; the rest of the API returns Mongo's
// `_id`. Send both so the client can migrate at its own pace and guest-mode data (which uses `id`)
// stays structurally identical to remote data.
function shape(doc) {
  return {
    id:             doc._id.toString(),
    _id:            doc._id.toString(),
    name:           doc.name,
    type:           doc.type,
    openingBalance: doc.openingBalance,
    color:          doc.color,
    icon:           doc.icon,
    createdAt:      doc.createdAt,
  };
}

exports.getAccounts = async (req, res) => {
  try {
    const accounts = await Account.find({ userId: req.user.id, deletedAt: null }).sort({ createdAt: 1 }).lean();
    res.json(accounts.map(shape));
  } catch (error) {
    console.error('Get accounts error:', error);
    res.status(500).json({ msg: 'Server Error' });
  }
};

exports.createAccount = async (req, res) => {
  try {
    const account = await Account.create({ ...req.body, userId: req.user.id });
    res.status(201).json(shape(account));
  } catch (error) {
    console.error('Create account error:', error);
    res.status(500).json({ msg: 'Server Error' });
  }
};

exports.updateAccount = async (req, res) => {
  try {
    // Scoped by userId in the filter, not checked afterwards — one query that cannot touch
    // someone else's account even if the id is guessed.
    const account = await Account.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id, deletedAt: null },
      { $set: req.body },
      { new: true, runValidators: true }
    );
    if (!account) return res.status(404).json({ msg: 'Account not found' });
    res.json(shape(account));
  } catch (error) {
    console.error('Update account error:', error);
    res.status(500).json({ msg: 'Server Error' });
  }
};

exports.deleteAccount = async (req, res) => {
  try {
    // Tombstone, not removal (W3-05).
    const account = await Account.findOneAndUpdate({ _id: req.params.id, userId: req.user.id, deletedAt: null }, { $set: { deletedAt: new Date() } });
    if (!account) return res.status(404).json({ msg: 'Account not found' });

    // Unassign rather than delete. The transactions are real spending the user has already seen;
    // deleting the account they were filed under must not delete the spending itself. This
    // mirrors what the local guest implementation does with its tx→account map.
    await Transaction.updateMany(
      { userId: req.user.id, accountId: account._id },
      { $set: { accountId: null } }
    );

    res.json({ msg: 'Account deleted' });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ msg: 'Server Error' });
  }
};

/**
 * The remote equivalent of the guest-mode `@tx_account_map_v2` blob: `{ [transactionId]: accountId }`.
 * Only assigned rows are returned, so the payload is proportional to what the user actually filed,
 * not to their whole history.
 */
exports.getTxAccountMap = async (req, res) => {
  try {
    const rows = await Transaction.find(
      { userId: req.user.id, accountId: { $ne: null }, deletedAt: null },
      { accountId: 1 }
    ).lean();

    const map = {};
    for (const row of rows) map[row._id.toString()] = row.accountId.toString();
    res.json(map);
  } catch (error) {
    console.error('Tx account map error:', error);
    res.status(500).json({ msg: 'Server Error' });
  }
};

/**
 * Assign (or with a null/absent accountId, clear) the account on one transaction.
 * Kept off the generic transaction update route so the app can set it without re-sending — and
 * risking clobbering — amount, category, note and the rest.
 */
exports.setTxAccount = async (req, res) => {
  try {
    const { accountId } = req.body;

    let value = null;
    if (accountId) {
      if (!mongoose.isValidObjectId(accountId)) {
        return res.status(400).json({ msg: 'Invalid accountId' });
      }
      // Verify ownership before writing the reference — otherwise a user could file their
      // transaction under someone else's account id.
      const owned = await Account.exists({ _id: accountId, userId: req.user.id });
      if (!owned) return res.status(404).json({ msg: 'Account not found' });
      value = accountId;
    }

    const tx = await Transaction.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      { $set: { accountId: value } },
      { new: true }
    );
    if (!tx) return res.status(404).json({ msg: 'Transaction not found' });

    res.json({ transactionId: tx._id.toString(), accountId: value });
  } catch (error) {
    console.error('Set tx account error:', error);
    res.status(500).json({ msg: 'Server Error' });
  }
};

/**
 * Bulk create for the guest→server sync. Returns `idMap`, the guest's local account id mapped to
 * the new server id, which is what lets syncService rewrite its transaction→account links before
 * importing the transactions themselves.
 */
exports.importAccounts = async (req, res) => {
  try {
    const { accounts } = req.body;
    if (!Array.isArray(accounts) || accounts.length === 0) {
      return res.status(400).json({ msg: 'accounts must be a non-empty array' });
    }
    if (accounts.length > 100) {
      return res.status(400).json({ msg: 'Maximum 100 accounts per import' });
    }

    const idMap = {};
    const created = [];

    for (const a of accounts) {
      // One malformed account must not fail the whole sync — the client reports what landed.
      try {
        const doc = await Account.create({
          userId:         req.user.id,
          name:           String(a.name || 'Account').trim().slice(0, 60),
          type:           a.type,
          openingBalance: Number(a.openingBalance) || 0,
          color:          a.color ? String(a.color).slice(0, 32) : '',
          icon:           a.icon  ? String(a.icon).slice(0, 64)  : '',
        });
        if (a.id) idMap[String(a.id)] = doc._id.toString();
        created.push(shape(doc));
      } catch {
        // Skipped; absent from idMap, so the client keeps it locally and can retry.
      }
    }

    res.status(201).json({ imported: created.length, received: accounts.length, idMap, accounts: created });
  } catch (error) {
    console.error('Import accounts error:', error);
    res.status(500).json({ msg: 'Server Error' });
  }
};
