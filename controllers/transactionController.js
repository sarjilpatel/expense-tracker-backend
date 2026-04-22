const Transaction = require("../models/Transaction");
const User = require("../models/User");
const Group = require("../models/Group");

// @desc    Add a new transaction
// @route   POST /api/transactions
// @access  Private
exports.addTransaction = async (req, res) => {
  try {
    const { amount, type, category, note, date } = req.body;
    const userId = req.user.id;

    // Ensure user exists and get groupId
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ msg: "User not found" });
    if (!user.groupId) return res.status(400).json({ msg: "User not in group" });

    // Validate category against group categories
    const group = await Group.findById(user.groupId);
    const isValidCategory = group.categories.some(c => c.name === category);
    
    if (!isValidCategory) {
      return res.status(400).json({
        msg: `Invalid category. Please use a group-defined category.`,
      });
    }

    const transaction = await Transaction.create({
      amount,
      type,
      category,
      note,
      userId,
      groupId: user.groupId,
      date: date || Date.now()
    });

    // Handle real-time notification
    const io = req.app.get("io");
    if (io) {
      const populatedTx = await Transaction.findById(transaction._id).populate("userId", "name profilePhoto");
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
    const { month, year } = req.query;

    const user = await User.findById(userId);
    if (!user || !user.groupId) return res.status(400).json({ msg: "Unauthorized" });

    let query = { groupId: user.groupId };

    if (month && year) {
      const startDate = new Date(parseInt(year), parseInt(month) - 1, 1);
      const endDate = new Date(parseInt(year), parseInt(month), 0, 23, 59, 59);
      query.date = { $gte: startDate, $lte: endDate };
    }

    const transactions = await Transaction.find(query)
      .sort({ date: -1 })
      .populate("userId", "name profilePhoto");

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
    const { month, year } = req.query;

    const user = await User.findById(userId);
    if (!user || !user.groupId) return res.status(400).json({ msg: "Unauthorized" });

    const { groupId } = user;
    let match = { groupId: groupId };

    if (month && year) {
      const startDate = new Date(parseInt(year), parseInt(month) - 1, 1);
      const endDate = new Date(parseInt(year), parseInt(month), 0, 23, 59, 59);
      match.date = { $gte: startDate, $lte: endDate };
    }

    const analytics = await Transaction.aggregate([
      { $match: match },
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
          incomeBreakdown: [
            { $match: { type: "income" } },
            {
              $group: {
                _id: "$category",
                total: { $sum: "$amount" },
              },
            },
            { $sort: { total: -1 } },
          ],
          weeklyTrends: [
             {
               $group: {
                 _id: { 
                   week: { $week: "$date" },
                   type: "$type"
                 },
                 total: { $sum: "$amount" }
               }
             },
             { $sort: { "_id.week": 1 } }
          ],
          memberBreakdown: [
            {
              $group: {
                _id: {
                  userId: "$userId",
                  type: "$type"
                },
                total: { $sum: "$amount" }
              }
            }
          ]
        },
      },
    ]);

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

    const incomeBreakdown = analytics[0].incomeBreakdown.map((item) => ({
      category: item._id,
      amount: item.total,
      percentage: totalIncome > 0 ? ((item.total / totalIncome) * 100).toFixed(1) : 0,
    }));

    // Process weekly trends
    const weeklyTrends = analytics[0].weeklyTrends.map(item => ({
        week: item._id.week,
        type: item._id.type,
        amount: item.total
    }));

    // Process member breakdown with names
    const memberBreakdownRaw = analytics[0].memberBreakdown;
    const userIds = [...new Set(memberBreakdownRaw.map(m => m._id.userId))];
    const users = await User.find({ _id: { $in: userIds } }).select('name profilePhoto');
    const userMap = users.reduce((acc, u) => {
        acc[u._id.toString()] = u;
        return acc;
    }, {});

    const memberBreakdown = memberBreakdownRaw.map(item => ({
        user: userMap[item._id.userId.toString()] || { name: 'Unknown' },
        type: item._id.type,
        amount: item.total,
        percentage: item._id.type === 'expense' 
            ? (totalExpense > 0 ? (item.total / totalExpense * 100).toFixed(1) : 0)
            : (totalIncome > 0 ? (item.total / totalIncome * 100).toFixed(1) : 0)
    }));

    res.json({
      totalIncome,
      totalExpense,
      balance: totalIncome - totalExpense,
      categoryBreakdown,
      incomeBreakdown,
      weeklyTrends,
      memberBreakdown
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ msg: "Server Error" });
  }
};

// @desc    Update a transaction
// @route   PUT /api/transactions/:id
// @access  Private
exports.updateTransaction = async (req, res) => {
  try {
    const { amount, type, category, note, date } = req.body;
    const userId = req.user.id;

    let transaction = await Transaction.findById(req.params.id);
    if (!transaction) return res.status(404).json({ msg: "Transaction not found" });

    const user = await User.findById(userId);
    if (transaction.groupId.toString() !== user.groupId.toString()) {
      return res.status(401).json({ msg: "User not authorized" });
    }

    if (category) {
      const group = await Group.findById(user.groupId);
      const isValidCategory = group.categories.some(c => c.name === category);
      if (!isValidCategory) return res.status(400).json({ msg: "Invalid category" });
    }

    const updatedFields = {};
    if (amount !== undefined) updatedFields.amount = amount;
    if (type) updatedFields.type = type;
    if (category) updatedFields.category = category;
    if (note !== undefined) updatedFields.note = note;
    if (date) updatedFields.date = date;

    transaction = await Transaction.findByIdAndUpdate(
      req.params.id,
      { $set: updatedFields },
      { new: true }
    ).populate("userId", "name profilePhoto");

    const io = req.app.get("io");
    if (io) io.to(user.groupId.toString()).emit("transaction_updated", transaction);

    res.json(transaction);
  } catch (error) {
    console.error(error);
    res.status(500).json({ msg: "Server Error" });
  }
};

exports.deleteTransaction = async (req, res) => {
  try {
    const userId = req.user.id;
    const transaction = await Transaction.findById(req.params.id);
    if (!transaction) return res.status(404).json({ msg: "Transaction not found" });

    const user = await User.findById(userId);
    if (transaction.groupId.toString() !== user.groupId.toString()) {
      return res.status(401).json({ msg: "User not authorized" });
    }

    await Transaction.findByIdAndDelete(req.params.id);

    const io = req.app.get("io");
    if (io) io.to(user.groupId.toString()).emit("transaction_deleted", req.params.id);

    res.json({ msg: "Transaction removed" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ msg: "Server Error" });
  }
};
