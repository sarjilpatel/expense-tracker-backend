const mongoose = require("mongoose");
const { syncable } = require("../utils/syncable");

// Accounts are personal, not shared: they are scoped by userId, never groupId. A group shares
// transactions and categories, but "my wallet" is not a thing the group should see or edit.
const accountSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: [true, "User ID is required"],
    index: true,
  },
  name: {
    type: String,
    required: [true, "Account name is required"],
    trim: true,
    maxlength: 60,
  },
  type: {
    type: String,
    enum: ["cash", "bank", "credit_card", "savings", "investment", "wallet", "other"],
    default: "other",
  },
  openingBalance: {
    type: Number,
    default: 0,
  },
  // Presentation only — the app picks sensible defaults per type, but the user can override both.
  color: { type: String, trim: true, maxlength: 32, default: "" },
  icon:  { type: String, trim: true, maxlength: 64, default: "" },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

accountSchema.plugin(syncable);
module.exports = mongoose.model("Account", accountSchema);
