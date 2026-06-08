const mongoose = require("mongoose");

const categorySchema = new mongoose.Schema({
  name: { type: String, required: true },
  icon: { type: String, default: "grid-outline" },
  type: { type: String, enum: ['income', 'expense', 'both'], default: 'expense' },
  isActive: { type: Boolean, default: true }
});

const pendingMemberSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  requestedAt: { type: Date, default: Date.now },
});

const groupSchema = new mongoose.Schema({
  name: String,
  joinCode: String,
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  members: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "User"
  }],
  pendingMembers: {
    type: [pendingMemberSchema],
    default: [],
  },
  categories: {
    type: [categorySchema],
    default: [
      { name: "Food", icon: "fast-food", type: "expense" },
      { name: "Transport", icon: "car", type: "expense" },
      { name: "Shopping", icon: "cart", type: "expense" },
      { name: "Rent", icon: "home", type: "expense" },
      { name: "Entertainment", icon: "game-controller", type: "expense" },
      { name: "Salary", icon: "cash", type: "income" },
      { name: "Business", icon: "briefcase", type: "income" },
      { name: "Investment", icon: "trending-up", type: "income" },
      { name: "Gift", icon: "gift", type: "income" },
      { name: "Other", icon: "ellipsis-horizontal", type: "both" }
    ]
  }
});

module.exports = mongoose.model("Group", groupSchema);
