const Split = require('../models/Split');
const User  = require('../models/User');

const populate = [
  { path: 'paidBy',       select: 'name profilePhoto' },
  { path: 'splits.userId', select: 'name profilePhoto' },
];

exports.getSplits = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user?.groupId) return res.status(400).json({ msg: 'User not in a group' });

    const splits = await Split.find({ groupId: user.groupId })
      .populate(populate)
      .sort({ createdAt: -1 });

    res.json(splits);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server Error' });
  }
};

exports.createSplit = async (req, res) => {
  try {
    const { title, totalAmount, currency, splits } = req.body;
    const user = await User.findById(req.user.id);
    if (!user?.groupId) return res.status(400).json({ msg: 'User not in a group' });

    if (!title || !totalAmount || !Array.isArray(splits) || splits.length < 2) {
      return res.status(400).json({ msg: 'Title, total amount, and at least 2 splits required' });
    }

    const sum = splits.reduce((acc, s) => acc + Number(s.amount), 0);
    if (Math.abs(sum - Number(totalAmount)) > 0.01) {
      return res.status(400).json({ msg: 'Split amounts must add up to the total' });
    }

    const paidById = req.user.id;

    const splitDoc = await Split.create({
      groupId:     user.groupId,
      paidBy:      paidById,
      title:       String(title).trim().slice(0, 80),
      totalAmount: Number(totalAmount),
      currency:    currency || 'INR',
      splits:      splits.map(s => ({
        userId:   s.userId,
        amount:   Number(s.amount),
        // Payer's own share is auto-settled
        settled:  s.userId.toString() === paidById.toString(),
        settledAt: s.userId.toString() === paidById.toString() ? new Date() : null,
      })),
    });

    const populated = await splitDoc.populate(populate);

    const io = req.app.get('io');
    if (io) io.to(user.groupId.toString()).emit('split_created', { _id: splitDoc._id, groupId: splitDoc.groupId });

    res.status(201).json(populated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server Error' });
  }
};

/**
 * Settling and un-settling a member's share differ only in the flag they write, so they share this
 * — every check around the flag (payer-only, member exists, group scope) is the interesting part,
 * and W1-27 is a standing reminder of what two copies of one rule do over time.
 *
 * Un-settling exists because settling was one-way: a payer who tapped Mark Paid on the wrong row
 * could only fix it by deleting the split and re-entering it, which loses everyone else's state
 * too. The payer is the only one who can settle, so they have to be the one who can take it back.
 */
async function setSettled(req, res, settled) {
  const { userId } = req.params;
  const user = await User.findById(req.user.id);
  if (!user?.groupId) return res.status(400).json({ msg: 'User not in a group' });

  const split = await Split.findOne({ _id: req.params.id, groupId: user.groupId });
  if (!split) return res.status(404).json({ msg: 'Split not found' });

  // Only the person who paid can confirm they were paid back. Group membership alone was the
  // whole check before, so any member could clear anyone else's debt — or their own. The app has
  // always gated the "Mark Paid" button on `split.paidBy._id === myId`; this makes the server
  // agree instead of trusting the client.
  if (split.paidBy.toString() !== req.user.id.toString()) {
    return res.status(403).json({
      msg: settled ? 'Only the payer can settle this split' : 'Only the payer can undo this',
    });
  }

  const entry = split.splits.find(s => s.userId.toString() === userId);
  if (!entry) return res.status(404).json({ msg: 'Member not in this split' });

  // The payer's own share is settled at creation because they cannot owe themselves. Letting it be
  // un-settled would leave the split permanently showing its own author as a debtor.
  if (!settled && entry.userId.toString() === split.paidBy.toString()) {
    return res.status(400).json({ msg: "The payer's own share cannot be marked unpaid" });
  }

  entry.settled   = settled;
  entry.settledAt = settled ? new Date() : null;
  await split.save();

  const populated = await split.populate(populate);

  const io = req.app.get('io');
  if (io) io.to(user.groupId.toString()).emit('split_updated', { _id: split._id, groupId: split.groupId });

  res.json(populated);
}

exports.settleSplit = async (req, res) => {
  try {
    await setSettled(req, res, true);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server Error' });
  }
};

exports.unsettleSplit = async (req, res) => {
  try {
    await setSettled(req, res, false);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server Error' });
  }
};

exports.deleteSplit = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user?.groupId) return res.status(400).json({ msg: 'User not in a group' });

    const split = await Split.findOne({ _id: req.params.id, groupId: user.groupId });
    if (!split) return res.status(404).json({ msg: 'Split not found' });

    // Same rule as settling: the split is the payer's record of what they are owed, so only they
    // can destroy it. Any group member could previously delete any split, wiping the evidence of
    // their own unsettled debt.
    if (split.paidBy.toString() !== req.user.id.toString()) {
      return res.status(403).json({ msg: 'Only the payer can delete this split' });
    }

    await split.deleteOne();

    const io = req.app.get('io');
    if (io) io.to(user.groupId.toString()).emit('split_deleted', req.params.id);

    res.json({ msg: 'Split deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server Error' });
  }
};
