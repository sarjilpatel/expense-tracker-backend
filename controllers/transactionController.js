const Transaction = require("../models/Transaction");
const User = require("../models/User");

const ALLOWED_CATEGORIES = ["Food", "Transport", "Shopping", "Rent", "Entertainment", "Other"];

// @desc    Add a new transaction
// @route   POST /api/transactions
// @access  Private
exports.addTransaction = async (req, res) => {
  try {
    const { amount, type, category, note } = req.body;
    const userId = req.user.id;

    // Validate category
    if (!ALLOWED_CATEGORIES.includes(category)) {
      return res.status(400).json({
        msg: `Invalid category. Allowed categories: ${ALLOWED_CATEGORIES.join(", ")}`,
      });
    }

    // Ensure user exists and get groupId
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ msg: "User not found" });
    }

    if (!user.groupId) {
      return res.status(400).json({ msg: "User not in group" });
    }

    const transaction = await Transaction.create({
      amount,
      type,
      category,
      note,
      userId,
      groupId: user.groupId,
    });

    // Handle real-time notification
    const io = req.app.get("io");
    if (io) {
      const populatedTx = await Transaction.findById(transaction._id).populate("userId", "name");
      io.to(user.groupId.toString()).emit("new_transaction", populatedTx);
    }

    res.status(201).json(transaction);
  } catch (error) {
    console.error(error);
    res.status(500).json({ msg: "Server Error" });
  }
};

// @desc    Get all transactions for the current user's group
// @route   GET /api/transactions
// @access  Private
exports.getTransactions = async (req, res) => {
  try {
    const userId = req.user.id;

    // Ensure user exists and get groupId
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ msg: "User not found" });
    }

    if (!user.groupId) {
      return res.status(400).json({ msg: "User not in group" });
    }

    const transactions = await Transaction.find({ groupId: user.groupId })
      .sort({ createdAt: -1 })
      .populate("userId", "name");

    res.json(transactions);
  } catch (error) {
    console.error(error);
    res.status(500).json({ msg: "Server Error" });
  }
};

// @desc    Get transaction analytics
// @route   GET /api/transactions/analytics
// @access  Private
exports.getAnalytics = async (req, res) => {
  try {
    const userId = req.user.id;

    // Ensure user exists and get groupId
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ msg: "User not found" });
    }

    if (!user.groupId) {
      return res.status(400).json({ msg: "User not in group" });
    }

    const { groupId } = user;

    const analytics = await Transaction.aggregate([
      { $match: { groupId: groupId } },
      {
        $facet: {
          summary: [
            {
              $group: {
                _id: "$type",
                total: { $sum: "$amount" },
              },
            },
          ],
          categoryBreakdown: [
            { $match: { type: "expense" } },
            {
              $group: {
                _id: "$category",
                total: { $sum: "$amount" },
              },
            },
            { $sort: { total: -1 } },
          ],
        },
      },
    ]);

    // Format the response
    const summaryData = analytics[0].summary;
    let totalIncome = 0;
    let totalExpense = 0;

    summaryData.forEach((item) => {
      if (item._id === "income") totalIncome = item.total;
      if (item._id === "expense") totalExpense = item.total;
    });

    const categoryBreakdown = analytics[0].categoryBreakdown.map((item) => ({
      category: item._id,
      amount: item.total,
      percentage: totalExpense > 0 ? ((item.total / totalExpense) * 100).toFixed(1) : 0,
    }));

    res.json({
      totalIncome,
      totalExpense,
      balance: totalIncome - totalExpense,
      categoryBreakdown,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ msg: "Server Error" });
  }
};
