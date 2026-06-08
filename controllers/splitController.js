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

exports.settleSplit = async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(req.user.id);
    if (!user?.groupId) return res.status(400).json({ msg: 'User not in a group' });

    const split = await Split.findOne({ _id: req.params.id, groupId: user.groupId });
    if (!split) return res.status(404).json({ msg: 'Split not found' });

    const entry = split.splits.find(s => s.userId.toString() === userId);
    if (!entry) return res.status(404).json({ msg: 'Member not in this split' });

    entry.settled   = true;
    entry.settledAt = new Date();
    await split.save();

    const populated = await split.populate(populate);

    const io = req.app.get('io');
    if (io) io.to(user.groupId.toString()).emit('split_updated', { _id: split._id, groupId: split.groupId });

    res.json(populated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server Error' });
  }
};

exports.deleteSplit = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user?.groupId) return res.status(400).json({ msg: 'User not in a group' });

    const split = await Split.findOneAndDelete({ _id: req.params.id, groupId: user.groupId });
    if (!split) return res.status(404).json({ msg: 'Split not found' });

    const io = req.app.get('io');
    if (io) io.to(user.groupId.toString()).emit('split_deleted', req.params.id);

    res.json({ msg: 'Split deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server Error' });
  }
};
