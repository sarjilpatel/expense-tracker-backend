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
  date: {
    type: Date,
    default: Date.now,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  currency: {
    type: String,
    enum: ['INR', 'USD', 'EUR', 'GBP', 'AED', 'JPY', 'CAD', 'AUD'],
    default: 'INR',
  },
  isRecurring: {
    type: Boolean,
    default: false,
  },
  recurrenceFrequency: {
    type: String,
    enum: ['daily', 'weekly', 'monthly', null],
    default: null,
  },
  nextDueDate: {
    type: Date,
    default: null,
  },
});

transactionSchema.index({ note: 'text', category: 'text' });

module.exports = mongoose.model("Transaction", transactionSchema);
