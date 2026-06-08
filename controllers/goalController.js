const Goal = require('../models/Goal');
const User = require('../models/User');

exports.getGoals = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user?.groupId) return res.status(400).json({ msg: 'User not in a group' });
    const goals = await Goal.find({ groupId: user.groupId }).sort({ createdAt: -1 });
    res.json(goals);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server Error' });
  }
};

exports.createGoal = async (req, res) => {
  try {
    const { name, targetAmount, savedAmount, deadline, icon, color } = req.body;
    const user = await User.findById(req.user.id);
    if (!user?.groupId) return res.status(400).json({ msg: 'User not in a group' });

    if (!name || !targetAmount || Number(targetAmount) < 1) {
      return res.status(400).json({ msg: 'Name and a positive target amount are required' });
    }

    const goal = await Goal.create({
      groupId:      user.groupId,
      userId:       req.user.id,
      name:         String(name).trim().slice(0, 60),
      targetAmount: Number(targetAmount),
      savedAmount:  Math.max(0, Number(savedAmount) || 0),
      deadline:     deadline || null,
      icon:         icon || 'flag-outline',
      color:        color || '#6366F1',
    });

    const io = req.app.get('io');
    if (io) io.to(user.groupId.toString()).emit('goal_created', goal);

    res.status(201).json(goal);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server Error' });
  }
};

exports.updateGoal = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user?.groupId) return res.status(400).json({ msg: 'User not in a group' });

    const goal = await Goal.findOne({ _id: req.params.id, groupId: user.groupId });
    if (!goal) return res.status(404).json({ msg: 'Goal not found' });

    const { name, targetAmount, savedAmount, deadline, icon, color, addAmount } = req.body;

    if (addAmount !== undefined) {
      // Quick "add funds" path
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

    const io = req.app.get('io');
    if (io) io.to(user.groupId.toString()).emit('goal_updated', goal);

    res.json(goal);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server Error' });
  }
};

exports.deleteGoal = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user?.groupId) return res.status(400).json({ msg: 'User not in a group' });

    const goal = await Goal.findOneAndDelete({ _id: req.params.id, groupId: user.groupId });
    if (!goal) return res.status(404).json({ msg: 'Goal not found' });

    const io = req.app.get('io');
    if (io) io.to(user.groupId.toString()).emit('goal_deleted', req.params.id);

    res.json({ msg: 'Goal deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server Error' });
  }
};
