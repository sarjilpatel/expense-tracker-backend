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

    const budget = await Budget.findOneAndUpdate(
      query,
      { amount },
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
    const budget = await Budget.findOneAndDelete({ _id: req.params.id, userId });
    if (!budget) return res.status(404).json({ msg: 'Budget not found' });
    res.json({ msg: 'Budget deleted' });
  } catch (err) {
    res.status(500).json({ msg: 'Server Error' });
  }
};
