const Budget = require("../models/Budget");
const User = require("../models/User");

// @desc    Get budgets for the current user
// @route   GET /api/budgets
// @access  Private
exports.getBudgets = async (req, res) => {
  try {
    const userId = req.user.id;
    const { month, year } = req.query;

    const now = new Date();
    const filter = {
      userId,
      deletedAt: null,
      month: month ? parseInt(month) : now.getMonth() + 1,
      year:  year  ? parseInt(year)  : now.getFullYear(),
    };

    const budgets = await Budget.find(filter);
    res.json(budgets);
  } catch (error) {
    console.error(error);
    res.status(500).json({ msg: "Server Error" });
  }
};

// @desc    Set or update a budget
// @route   POST /api/budgets
// @access  Private
exports.setBudget = async (req, res) => {
  try {
    const { amount, month, year, category } = req.body;
    const userId = req.user.id;

    const now = new Date();
    const query = {
      userId,
      month:    month    || now.getMonth() + 1,
      year:     year     || now.getFullYear(),
      category: category || null,
    };

    // A budget that was deleted and set again on the same period is the same row revived.
    const budget = await Budget.findOneAndUpdate(
      query,
      { $set: { amount, deletedAt: null } },
      { upsert: true, new: true }
    );

    res.json(budget);
  } catch (error) {
    console.error(error);
    res.status(500).json({ msg: "Server Error" });
  }
};

// @desc    Delete a budget
// @route   DELETE /api/budgets/:id
// @access  Private
exports.deleteBudget = async (req, res) => {
  try {
    const userId = req.user.id;
    // Tombstone, not removal (W3-05): the sync feed has to be able to tell other devices.
    const budget = await Budget.findOneAndUpdate({ _id: req.params.id, userId, deletedAt: null }, { $set: { deletedAt: new Date() } });
    if (!budget) return res.status(404).json({ msg: 'Budget not found' });
    res.json({ msg: 'Budget deleted' });
  } catch (err) {
    res.status(500).json({ msg: 'Server Error' });
  }
};
