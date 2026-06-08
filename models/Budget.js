const mongoose = require("mongoose");

const budgetSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  // Optional: when set, this budget belongs to a group context
  groupId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Group",
    default: null,
  },
  amount: {
    type: Number,
    required: true,
  },
  month: {
    type: Number, // 1-12
    required: true,
  },
  year: {
    type: Number,
    required: true,
  },
  category: {
    type: String, // null = total budget for the period
    default: null,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("Budget", budgetSchema);
