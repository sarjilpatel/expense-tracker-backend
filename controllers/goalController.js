const Goal = require('../models/Goal');
const User = require('../models/User');

exports.getGoals = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);
    if (!user) return res.status(401).json({ msg: 'Unauthorized' });

    // Personal goals + group goals if user is in a group
    const query = user.groupId
      ? { $or: [{ userId }, { groupId: user.groupId }] }
      : { userId };

    const goals = await Goal.find(query).sort({ createdAt: -1 });
    res.json(goals);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server Error' });
  }
};

exports.createGoal = async (req, res) => {
  try {
    const { name, targetAmount, savedAmount, deadline, icon, color } = req.body;
    const userId = req.user.id;
    const user = await User.findById(userId);
    if (!user) return res.status(401).json({ msg: 'Unauthorized' });

    if (!name || !targetAmount || Number(targetAmount) < 1) {
      return res.status(400).json({ msg: 'Name and a positive target amount are required' });
    }

    const goal = await Goal.create({
      userId,
      groupId:      user.groupId || null,
      name:         String(name).trim().slice(0, 60),
      targetAmount: Number(targetAmount),
      savedAmount:  Math.max(0, Number(savedAmount) || 0),
      deadline:     deadline || null,
      icon:         icon || 'flag-outline',
      color:        color || '#6366F1',
    });

    if (user.groupId) {
      const io = req.app.get('io');
      if (io) io.to(user.groupId.toString()).emit('goal_created', { _id: goal._id, groupId: goal.groupId });
    }

    res.status(201).json(goal);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server Error' });
  }
};

exports.updateGoal = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);
    if (!user) return res.status(401).json({ msg: 'Unauthorized' });

    // User can update their own goals or group goals if in the same group
    const query = user.groupId
      ? { _id: req.params.id, $or: [{ userId }, { groupId: user.groupId }] }
      : { _id: req.params.id, userId };

    const goal = await Goal.findOne(query);
    if (!goal) return res.status(404).json({ msg: 'Goal not found' });

    const { name, targetAmount, savedAmount, deadline, icon, color, addAmount } = req.body;

    if (addAmount !== undefined) {
      goal.savedAmount = Math.max(0, goal.savedAmount + Number(addAmount));
    } else {
      if (name !== undefined)         goal.name         = String(name).trim().slice(0, 60);
      if (targetAmount !== undefined) goal.targetAmount = Math.max(1, Number(targetAmount));
      if (savedAmount !== undefined)  goal.savedAmount  = Math.max(0, Number(savedAmount));
      if (deadline !== undefined)     goal.deadline     = deadline || null;
      if (icon !== undefined)         goal.icon         = icon;
      if (color !== undefined)        goal.color        = color;
    }

    await goal.save();

    if (user.groupId && goal.groupId?.toString() === user.groupId.toString()) {
      const io = req.app.get('io');
      if (io) io.to(user.groupId.toString()).emit('goal_updated', { _id: goal._id, groupId: goal.groupId });
    }

    res.json(goal);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server Error' });
  }
};

exports.deleteGoal = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);
    if (!user) return res.status(401).json({ msg: 'Unauthorized' });

    const query = user.groupId
      ? { _id: req.params.id, $or: [{ userId }, { groupId: user.groupId }] }
      : { _id: req.params.id, userId };

    const goal = await Goal.findOneAndDelete(query);
    if (!goal) return res.status(404).json({ msg: 'Goal not found' });

    if (user.groupId && goal.groupId?.toString() === user.groupId.toString()) {
      const io = req.app.get('io');
      if (io) io.to(user.groupId.toString()).emit('goal_deleted', req.params.id);
    }

    res.json({ msg: 'Goal deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server Error' });
  }
};
