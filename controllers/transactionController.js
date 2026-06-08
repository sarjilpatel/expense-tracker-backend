const Transaction = require("../models/Transaction");
const User = require("../models/User");
const Group = require("../models/Group");

// Returns a Mongoose query filter scoped to what the user can see.
// Group members see all group transactions (excluding others' private ones).
// Solo users see only their own transactions.
function buildScope(user) {
  if (user.groupId) {
    return {
      groupId: user.groupId,
      deletedAt: null,
      $or: [{ isPrivate: { $ne: true } }, { userId: user._id }],
    };
  }
  return { userId: user._id, deletedAt: null };
}

// @desc    Add a new transaction
// @route   POST /api/transactions
// @access  Private
exports.addTransaction = async (req, res) => {
  try {
    const { amount, type, category, date, isRecurring, recurrenceFrequency, currency, isPrivate } = req.body;
    const note = req.body.note ? String(req.body.note).trim().slice(0, 200) : undefined;
    const userId = req.user.id;

    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ msg: "Amount must be greater than 0" });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ msg: "User not found" });

    // Category validation only applies when the user is in a group (group defines categories)
    if (user.groupId) {
      const group = await Group.findById(user.groupId);
      if (group) {
        const isValidCategory = group.categories.some(c => c.name === category);
        if (!isValidCategory) {
          return res.status(400).json({ msg: "Invalid category. Please use a group-defined category." });
        }
      }
    }

    let nextDueDate = null;
    if (isRecurring && recurrenceFrequency) {
      const base = date ? new Date(date) : new Date();
      if (recurrenceFrequency === 'daily')   nextDueDate = new Date(base.setDate(base.getDate() + 1));
      else if (recurrenceFrequency === 'weekly')  nextDueDate = new Date(base.setDate(base.getDate() + 7));
      else if (recurrenceFrequency === 'monthly') nextDueDate = new Date(base.setMonth(base.getMonth() + 1));
    }

    const transaction = await Transaction.create({
      amount,
      type,
      category,
      note,
      userId,
      groupId: user.groupId || null,
      date: date || Date.now(),
      currency: currency || 'INR',
      isRecurring: !!isRecurring,
      recurrenceFrequency: isRecurring ? recurrenceFrequency : null,
      nextDueDate,
      isPrivate: !!isPrivate,
    });

    if (user.groupId) {
      const io = req.app.get("io");
      if (io) {
        const populatedTx = await Transaction.findById(transaction._id).populate("userId", "name profilePhoto");
        const { note: _omit, isRecurring, recurrenceFrequency, nextDueDate, ...socketPayload } = populatedTx.toObject();
        io.to(user.groupId.toString()).emit("new_transaction", socketPayload);
      }
    }

    res.status(201).json(transaction);
  } catch (error) {
    console.error(error);
    res.status(500).json({ msg: "Server Error" });
  }
};

// @desc    Get transactions (group-scoped or personal)
// @route   GET /api/transactions
// @access  Private
exports.getTransactions = async (req, res) => {
  try {
    const userId = req.user.id;
    const { month, year, search, page, limit: limitParam } = req.query;

    const user = await User.findById(userId);
    if (!user) return res.status(401).json({ msg: "Unauthorized" });

    const query = buildScope(user);

    if (year) {
      let startDate, endDate;
      if (month) {
        startDate = new Date(parseInt(year), parseInt(month) - 1, 1);
        endDate   = new Date(parseInt(year), parseInt(month), 0, 23, 59, 59);
      } else {
        startDate = new Date(parseInt(year), 0, 1);
        endDate   = new Date(parseInt(year), 11, 31, 23, 59, 59);
      }
      query.date = { $gte: startDate, $lte: endDate };
    }

    if (search && search.trim()) {
      const term = search.trim();
      // Override the $or from buildScope when searching by text
      query.$or = [
        { note: { $regex: term, $options: 'i' } },
        { category: { $regex: term, $options: 'i' } },
      ];
    }

    const pageNum  = Math.max(1, parseInt(page  || '1',  10));
    const pageSize = Math.min(100, Math.max(1, parseInt(limitParam || '50', 10)));
    const skip     = (pageNum - 1) * pageSize;

    const [transactions, total] = await Promise.all([
      Transaction.find(query).sort({ date: -1 }).skip(skip).limit(pageSize).populate("userId", "name profilePhoto"),
      Transaction.countDocuments(query),
    ]);

    res.json({
      transactions,
      pagination: { page: pageNum, limit: pageSize, total, pages: Math.ceil(total / pageSize) },
    });
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
    if (!user) return res.status(401).json({ msg: "Unauthorized" });

    const match = { ...buildScope(user) };

    const m = parseInt(month);
    const y = parseInt(year);

    if (y) {
      let startDate, endDate;
      if (m) {
        startDate = new Date(y, m - 1, 1);
        endDate   = new Date(y, m, 0, 23, 59, 59);
      } else {
        startDate = new Date(y, 0, 1);
        endDate   = new Date(y, 11, 31, 23, 59, 59);
      }
      match.date = { $gte: startDate, $lte: endDate };
    }

    // Previous month comparison
    let prevIncome = 0, prevExpense = 0;
    if (m && y) {
      const prevDate = new Date(y, m - 2, 1);
      const prevEnd  = new Date(y, m - 1, 0, 23, 59, 59);
      const prevScope = { ...buildScope(user), date: { $gte: prevDate, $lte: prevEnd } };
      const prevAgg = await Transaction.aggregate([
        { $match: prevScope },
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
          summary:          [{ $group: { _id: "$type", total: { $sum: "$amount" } } }],
          categoryBreakdown:[
            { $match: { type: "expense" } },
            { $group: { _id: "$category", total: { $sum: "$amount" } } },
            { $sort: { total: -1 } },
          ],
          incomeBreakdown:  [
            { $match: { type: "income" } },
            { $group: { _id: "$category", total: { $sum: "$amount" } } },
            { $sort: { total: -1 } },
          ],
          weeklyTrends: [
            { $group: { _id: { week: { $week: "$date" }, type: "$type" }, total: { $sum: "$amount" } } },
            { $sort: { "_id.week": 1 } }
          ],
          dailyBreakdown: [
            { $group: { _id: { day: { $dayOfMonth: "$date" }, type: "$type" }, total: { $sum: "$amount" } } },
            { $sort: { "_id.day": 1 } }
          ],
          memberBreakdown: [
            { $group: { _id: { userId: "$userId", type: "$type" }, total: { $sum: "$amount" } } }
          ]
        },
      },
    ]);

    const summaryData = analytics[0].summary;
    let totalIncome = 0, totalExpense = 0;
    summaryData.forEach(item => {
      if (item._id === "income")  totalIncome  = item.total;
      if (item._id === "expense") totalExpense = item.total;
    });

    const categoryBreakdown = analytics[0].categoryBreakdown.map(item => ({
      category: item._id,
      amount: item.total,
      percentage: totalExpense > 0 ? ((item.total / totalExpense) * 100).toFixed(1) : 0,
    }));

    const incomeBreakdown = analytics[0].incomeBreakdown.map(item => ({
      category: item._id,
      amount: item.total,
      percentage: totalIncome > 0 ? ((item.total / totalIncome) * 100).toFixed(1) : 0,
    }));

    const weeklyTrends = analytics[0].weeklyTrends.map(item => ({
      week: item._id.week,
      type: item._id.type,
      amount: item.total
    }));

    const dailyMap = {};
    analytics[0].dailyBreakdown.forEach(item => {
      const d = item._id.day;
      if (!dailyMap[d]) dailyMap[d] = { day: d, income: 0, expense: 0 };
      dailyMap[d][item._id.type] = item.total;
    });
    const dailyBreakdown = Object.values(dailyMap).sort((a, b) => a.day - b.day);

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
      memberBreakdown,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ msg: "Server Error" });
  }
};

// @desc    Get monthly trend for the last N months
// @route   GET /api/transactions/analytics/trend
// @access  Private
exports.getTrend = async (req, res) => {
  try {
    const userId = req.user.id;
    const months = Math.min(parseInt(req.query.months) || 6, 12);

    const user = await User.findById(userId);
    if (!user) return res.status(401).json({ msg: "Unauthorized" });

    const now       = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);

    const scope = buildScope(user);
    const agg = await Transaction.aggregate([
      { $match: { ...scope, date: { $gte: startDate } } },
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

      result.push({ month: m, year: y, monthLabel: d.toLocaleString('en', { month: 'short' }), income, expense, net: income - expense });
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
    const { amount, type, category, date, currency, isPrivate } = req.body;
    const note = req.body.note !== undefined ? String(req.body.note).trim().slice(0, 200) : undefined;
    const userId = req.user.id;

    if (amount !== undefined && (isNaN(Number(amount)) || Number(amount) <= 0)) {
      return res.status(400).json({ msg: "Amount must be greater than 0" });
    }

    const transaction = await Transaction.findById(req.params.id);
    if (!transaction) return res.status(404).json({ msg: "Transaction not found" });

    // Only the owner of the transaction can edit it
    if (transaction.userId.toString() !== userId) {
      return res.status(403).json({ msg: "You can only edit your own transactions" });
    }

    const user = await User.findById(userId);

    // Validate category against group if user is in one
    if (category && user.groupId) {
      const group = await Group.findById(user.groupId);
      if (group) {
        const isValidCategory = group.categories.some(c => c.name === category);
        if (!isValidCategory) return res.status(400).json({ msg: "Invalid category" });
      }
    }

    const updatedFields = {};
    if (amount !== undefined) updatedFields.amount = amount;
    if (type)     updatedFields.type     = type;
    if (category) updatedFields.category = category;
    if (note !== undefined) updatedFields.note = note;
    if (date)     updatedFields.date     = date;
    if (currency) updatedFields.currency = currency;
    if (isPrivate !== undefined) updatedFields.isPrivate = !!isPrivate;

    const updated = await Transaction.findByIdAndUpdate(
      req.params.id,
      { $set: updatedFields },
      { new: true }
    ).populate("userId", "name profilePhoto");

    if (user.groupId && transaction.groupId?.toString() === user.groupId.toString()) {
      const io = req.app.get("io");
      if (io) {
        const { note: _omit, isRecurring, recurrenceFrequency, nextDueDate, ...socketPayload } = updated.toObject();
        io.to(user.groupId.toString()).emit("transaction_updated", socketPayload);
      }
    }

    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ msg: "Server Error" });
  }
};

// @desc    Generate AI spending insights
// @route   GET /api/transactions/insights
// @access  Private
exports.getInsights = async (req, res) => {
  try {
    const userId = req.user.id;
    const { month, year } = req.query;

    const user = await User.findById(userId);
    if (!user) return res.status(401).json({ msg: "Unauthorized" });

    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year)  || new Date().getFullYear();

    const startDate = new Date(y, m - 1, 1);
    const endDate   = new Date(y, m, 0, 23, 59, 59);
    const prevDate  = new Date(y, m - 2, 1);
    const prevEnd   = new Date(y, m - 1, 0, 23, 59, 59);

    const scope = buildScope(user);

    const [analytics, prevAgg] = await Promise.all([
      Transaction.aggregate([
        { $match: { ...scope, date: { $gte: startDate, $lte: endDate } } },
        {
          $facet: {
            summary:     [{ $group: { _id: "$type", total: { $sum: "$amount" } } }],
            topExpenses: [
              { $match: { type: "expense" } },
              { $group: { _id: "$category", total: { $sum: "$amount" } } },
              { $sort: { total: -1 } },
              { $limit: 5 }
            ],
          }
        }
      ]),
      Transaction.aggregate([
        { $match: { ...scope, date: { $gte: prevDate, $lte: prevEnd } } },
        { $group: { _id: "$type", total: { $sum: "$amount" } } }
      ])
    ]);

    let totalIncome = 0, totalExpense = 0, prevIncome = 0, prevExpense = 0;
    analytics[0].summary.forEach(a => {
      if (a._id === 'income')  totalIncome  = a.total;
      if (a._id === 'expense') totalExpense = a.total;
    });
    prevAgg.forEach(a => {
      if (a._id === 'income')  prevIncome  = a.total;
      if (a._id === 'expense') prevExpense = a.total;
    });

    if (totalIncome === 0 && totalExpense === 0) {
      return res.json({ insights: [], month: m, year: y, noData: true });
    }

    const topExpenses = analytics[0].topExpenses.map(c => ({
      category: c._id,
      amount:   c.total,
      pct:      totalExpense > 0 ? ((c.total / totalExpense) * 100).toFixed(1) : '0'
    }));

    const monthName   = new Date(y, m - 1).toLocaleString('en', { month: 'long' });
    const savings     = totalIncome - totalExpense;
    const savingsRate = totalIncome > 0 ? ((savings / totalIncome) * 100).toFixed(1) : null;
    const expChange   = prevExpense > 0 ? ((totalExpense - prevExpense) / prevExpense * 100).toFixed(1) : null;
    const fmt         = n => n.toLocaleString('en-IN');

    const prompt =
`You are a personal finance advisor for an Indian household. Analyze this data for ${monthName} ${y} and give 3 sharp, specific insights. Use ₹ for currency. Be friendly and actionable.

Summary:
- Income: ₹${fmt(totalIncome)}
- Expenses: ₹${fmt(totalExpense)}
- Net Savings: ₹${fmt(savings)}${savingsRate !== null ? ` (${savingsRate}% savings rate)` : ''}${expChange !== null ? `\n- Expense change vs last month: ${parseFloat(expChange) >= 0 ? '+' : ''}${expChange}%` : ''}${prevExpense > 0 ? `\n- Last month expenses: ₹${fmt(prevExpense)}` : ''}

Top expense categories:
${topExpenses.map(c => `- ${c.category}: ₹${fmt(c.amount)} (${c.pct}%)`).join('\n')}

Reply ONLY with a JSON array of exactly 3 objects:
[{"title":"Short Title","body":"2-sentence insight with specific numbers.","type":"positive|warning|neutral"}]`;

    const AnthropicSdk   = require('@anthropic-ai/sdk');
    const AnthropicClass = AnthropicSdk.default || AnthropicSdk;
    const aiClient       = new AnthropicClass({ apiKey: process.env.ANTHROPIC_API_KEY });

    const stream  = aiClient.messages.stream({
      model:      'claude-opus-4-8',
      max_tokens: 1024,
      thinking:   { type: 'adaptive' },
      messages:   [{ role: 'user', content: prompt }],
    });
    const message = await stream.finalMessage();

    const textBlock = message.content.find(c => c.type === 'text');
    const rawText   = textBlock?.text?.trim() || '[]';

    let insights;
    try {
      const json = rawText.replace(/^```[a-z]*\n?|```\s*$/g, '').trim();
      insights   = JSON.parse(json);
    } catch {
      insights = [{ title: 'Monthly Summary', body: rawText, type: 'neutral' }];
    }

    res.json({ insights, month: m, year: y });
  } catch (error) {
    console.error('AI Insights error:', error.message);
    res.status(500).json({ msg: 'Failed to generate insights' });
  }
};

exports.deleteTransaction = async (req, res) => {
  try {
    const userId = req.user.id;
    const transaction = await Transaction.findById(req.params.id);
    if (!transaction || transaction.deletedAt) return res.status(404).json({ msg: "Transaction not found" });

    const user = await User.findById(userId);

    // Authorization: owner of the transaction OR a member of the same group
    const isOwner       = transaction.userId.toString() === userId;
    const isGroupMember = user.groupId && transaction.groupId?.toString() === user.groupId.toString();
    if (!isOwner && !isGroupMember) {
      return res.status(401).json({ msg: "User not authorized" });
    }

    await Transaction.findByIdAndUpdate(req.params.id, { deletedAt: new Date() });

    if (isGroupMember) {
      const io = req.app.get("io");
      if (io) io.to(user.groupId.toString()).emit("transaction_deleted", req.params.id);
    }

    res.json({ msg: "Transaction removed" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ msg: "Server Error" });
  }
};

exports.restoreTransaction = async (req, res) => {
  try {
    const userId = req.user.id;
    const transaction = await Transaction.findById(req.params.id);
    if (!transaction || !transaction.deletedAt) return res.status(404).json({ msg: "Transaction not found or not deleted" });

    // Only the owner of the transaction can restore it
    if (transaction.userId.toString() !== userId) {
      return res.status(403).json({ msg: "You can only restore your own transactions" });
    }

    await Transaction.findByIdAndUpdate(req.params.id, { deletedAt: null });
    res.json({ msg: "Transaction restored" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ msg: "Server Error" });
  }
};
