const Budget = require("../models/Budget");
const User = require("../models/User");

// @desc    Delete a budget
// @route   DELETE /api/budgets/:id
// @access  Private
exports.deleteBudget = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        const budget = await Budget.findOneAndDelete({
            _id: req.params.id,
            groupId: user.groupId
        });
        if (!budget) return res.status(404).json({ msg: 'Budget not found' });
        res.json({ msg: 'Budget deleted' });
    } catch (err) {
        res.status(500).send('Server Error');
    }
};

// @desc    Get budget for the current group
// @route   GET /api/budgets
// @access  Private
exports.getBudgets = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);
    
    if (!user || !user.groupId) {
        return res.status(400).json({ msg: "User not in a group" });
    }

    const { month, year } = req.query;
    const filter = { groupId: user.groupId };
    
    if (month && year) {
        filter.month = parseInt(month);
        filter.year = parseInt(year);
    } else {
        const now = new Date();
        filter.month = now.getMonth() + 1;
        filter.year = now.getFullYear();
    }

    const budgets = await Budget.find(filter);
    res.json(budgets);
  } catch (error) {
    console.error(error);
    res.status(500).json({ msg: "Server Error" });
  }
};

// @desc    Set or update budget
// @route   POST /api/budgets
// @access  Private
exports.setBudget = async (req, res) => {
  try {
    const { amount, month, year, category } = req.body;
    const userId = req.user.id;
    const user = await User.findById(userId);

    if (!user || !user.groupId) {
        return res.status(400).json({ msg: "User not in a group" });
    }

    const query = {
      groupId: user.groupId,
      month: month || new Date().getMonth() + 1,
      year: year || new Date().getFullYear(),
      category: category || null
    };

    const update = { amount };
    
    const budget = await Budget.findOneAndUpdate(
      query,
      update,
      { upsert: true, new: true }
    );

    res.json(budget);
  } catch (error) {
    console.error(error);
    res.status(500).json({ msg: "Server Error" });
  }
};
