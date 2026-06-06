const Transaction = require("../models/Transaction");
const User = require("../models/User");
const Group = require("../models/Group");

// @desc    Add a new transaction
// @route   POST /api/transactions
// @access  Private
exports.addTransaction = async (req, res) => {
  try {
    const { amount, type, category, date, isRecurring, recurrenceFrequency } = req.body;
    const note = req.body.note ? String(req.body.note).trim().slice(0, 200) : undefined;
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

    let nextDueDate = null;
    if (isRecurring && recurrenceFrequency) {
        const base = date ? new Date(date) : new Date();
        if (recurrenceFrequency === 'daily') nextDueDate = new Date(base.setDate(base.getDate() + 1));
        else if (recurrenceFrequency === 'weekly') nextDueDate = new Date(base.setDate(base.getDate() + 7));
        else if (recurrenceFrequency === 'monthly') nextDueDate = new Date(base.setMonth(base.getMonth() + 1));
    }

    const transaction = await Transaction.create({
      amount,
      type,
      category,
      note,
      userId,
      groupId: user.groupId,
      date: date || Date.now(),
      isRecurring: !!isRecurring,
      recurrenceFrequency: isRecurring ? recurrenceFrequency : null,
      nextDueDate,
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
    const { month, year, search } = req.query;

    const user = await User.findById(userId);
    if (!user || !user.groupId) return res.status(400).json({ msg: "Unauthorized" });

    let query = { groupId: user.groupId };

    if (year) {
      let startDate, endDate;
      if (month) {
        startDate = new Date(parseInt(year), parseInt(month) - 1, 1);
        endDate = new Date(parseInt(year), parseInt(month), 0, 23, 59, 59);
      } else {
        startDate = new Date(parseInt(year), 0, 1);
        endDate = new Date(parseInt(year), 11, 31, 23, 59, 59);
      }
      query.date = { $gte: startDate, $lte: endDate };
    }

    if (search && search.trim()) {
      const term = search.trim();
      query.$or = [
        { note: { $regex: term, $options: 'i' } },
        { category: { $regex: term, $options: 'i' } },
      ];
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

    const m = parseInt(month);
    const y = parseInt(year);

    if (y) {
      let startDate, endDate;
      if (m) {
        startDate = new Date(y, m - 1, 1);
        endDate = new Date(y, m, 0, 23, 59, 59);
      } else {
        startDate = new Date(y, 0, 1);
        endDate = new Date(y, 11, 31, 23, 59, 59);
      }
      match.date = { $gte: startDate, $lte: endDate };
    }

    // Previous month range for comparison
    let prevIncome = 0, prevExpense = 0;
    if (m && y) {
      const prevDate = new Date(y, m - 2, 1);
      const prevEnd  = new Date(y, m - 1, 0, 23, 59, 59);
      const prevAgg = await Transaction.aggregate([
        { $match: { groupId, date: { $gte: prevDate, $lte: prevEnd } } },
        { $group: { _id: "$type", total: { $sum: "$amount" } } }
      ]);
      prevAgg.forEach(a => {
        if (a._id === "income")  prevIncome  = a.total;
        if (a._id === "expense") prevExpense = a.total;
      });
    }

    const analytics = await Transaction.aggregate([
      { $match: match },
      {
        $facet: {
          summary: [
            { $group: { _id: "$type", total: { $sum: "$amount" } } },
          ],
          categoryBreakdown: [
            { $match: { type: "expense" } },
            { $group: { _id: "$category", total: { $sum: "$amount" } } },
            { $sort: { total: -1 } },
          ],
          incomeBreakdown: [
            { $match: { type: "income" } },
            { $group: { _id: "$category", total: { $sum: "$amount" } } },
            { $sort: { total: -1 } },
          ],
          weeklyTrends: [
            {
              $group: {
                _id: { week: { $week: "$date" }, type: "$type" },
                total: { $sum: "$amount" }
              }
            },
            { $sort: { "_id.week": 1 } }
          ],
          dailyBreakdown: [
            {
              $group: {
                _id: { day: { $dayOfMonth: "$date" }, type: "$type" },
                total: { $sum: "$amount" }
              }
            },
            { $sort: { "_id.day": 1 } }
          ],
          memberBreakdown: [
            {
              $group: {
                _id: { userId: "$userId", type: "$type" },
                total: { $sum: "$amount" }
              }
            }
          ]
        },
      },
    ]);

    const summaryData = analytics[0].summary;
    let totalIncome = 0, totalExpense = 0;
    summaryData.forEach((item) => {
      if (item._id === "income")  totalIncome  = item.total;
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

    const weeklyTrends = analytics[0].weeklyTrends.map(item => ({
      week: item._id.week,
      type: item._id.type,
      amount: item.total
    }));

    // Build daily breakdown: [{day, income, expense}]
    const dailyMap = {};
    analytics[0].dailyBreakdown.forEach(item => {
      const d = item._id.day;
      if (!dailyMap[d]) dailyMap[d] = { day: d, income: 0, expense: 0 };
      dailyMap[d][item._id.type] = item.total;
    });
    const dailyBreakdown = Object.values(dailyMap).sort((a, b) => a.day - b.day);

    // Member breakdown with names
    const memberBreakdownRaw = analytics[0].memberBreakdown;
    const userIds = [...new Set(memberBreakdownRaw.map(m => m._id.userId))];
    const users = await User.find({ _id: { $in: userIds } }).select('name profilePhoto');
    const userMap = users.reduce((acc, u) => { acc[u._id.toString()] = u; return acc; }, {});

    const memberBreakdown = memberBreakdownRaw.map(item => ({
      user: userMap[item._id.userId?.toString()] || { name: 'Unknown' },
      type: item._id.type,
      amount: item.total,
      percentage: item._id.type === 'expense'
        ? (totalExpense > 0 ? (item.total / totalExpense * 100).toFixed(1) : 0)
        : (totalIncome  > 0 ? (item.total / totalIncome  * 100).toFixed(1) : 0)
    }));

    res.json({
      totalIncome,
      totalExpense,
      balance: totalIncome - totalExpense,
      previousMonth: { totalIncome: prevIncome, totalExpense: prevExpense },
      categoryBreakdown,
      incomeBreakdown,
      weeklyTrends,
      dailyBreakdown,
      memberBreakdown
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ msg: "Server Error" });
  }
};

// @desc    Get monthly trend data for the last N months
// @route   GET /api/transactions/analytics/trend
// @access  Private
exports.getTrend = async (req, res) => {
  try {
    const userId = req.user.id;
    const months = Math.min(parseInt(req.query.months) || 6, 12);

    const user = await User.findById(userId);
    if (!user || !user.groupId) return res.status(400).json({ msg: "Unauthorized" });

    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);

    const agg = await Transaction.aggregate([
      { $match: { groupId: user.groupId, date: { $gte: startDate } } },
      {
        $group: {
          _id: { year: { $year: "$date" }, month: { $month: "$date" }, type: "$type" },
          total: { $sum: "$amount" }
        }
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } }
    ]);

    const result = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const m = d.getMonth() + 1;
      const y = d.getFullYear();

      const incItem = agg.find(a => a._id.year === y && a._id.month === m && a._id.type === 'income');
      const expItem = agg.find(a => a._id.year === y && a._id.month === m && a._id.type === 'expense');

      const income  = incItem?.total || 0;
      const expense = expItem?.total || 0;

      result.push({
        month: m,
        year: y,
        monthLabel: d.toLocaleString('en', { month: 'short' }),
        income,
        expense,
        net: income - expense
      });
    }

    res.json(result);
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
    const { amount, type, category, date } = req.body;
    const note = req.body.note !== undefined ? String(req.body.note).trim().slice(0, 200) : undefined;
    const userId = req.user.id;

    let transaction = await Transaction.findById(req.params.id);
    if (!transaction) return res.status(404).json({ msg: "Transaction not found" });

    if (transaction.userId.toString() !== userId) {
      return res.status(403).json({ msg: "You can only edit your own transactions" });
    }

    const user = await User.findById(userId);
    if (transaction.groupId.toString() !== user.groupId.toString()) {
      return res.status(403).json({ msg: "User not authorized" });
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
