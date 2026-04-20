const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema({
  amount: {
    type: Number,
    required: [true, "Amount is required"],
  },
  type: {
    type: String,
    enum: ["income", "expense"],
    required: [true, "Transaction type is required"],
  },
  category: {
    type: String,
    enum: ["Food", "Travel", "Shopping", "Bills", "Health", "Other"],
    required: [true, "Category is required"],
  },
  note: {
    type: String,
    trim: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: [true, "User ID is required"],
  },
  groupId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Group",
    required: [true, "Group ID is required"],
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("Transaction", transactionSchema);
