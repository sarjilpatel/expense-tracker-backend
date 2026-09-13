const mongoose = require("mongoose");

const categorySchema = new mongoose.Schema({
  name: { type: String, required: true },
  icon: { type: String, default: "grid-outline" },
  // The app has always sent an emoji when adding a category and this schema has always dropped it,
  // so a guest who signed in lost the emoji on every one of theirs. Optional: the older rows have
  // none, and the app falls back to the icon.
  emoji: { type: String, default: "" },
  type: { type: String, enum: ['income', 'expense', 'both'], default: 'expense' },
  isActive: { type: Boolean, default: true },
  // Sync fields (W3-05/06) — the same trio the top-level models get from the syncable plugin,
  // kept by the group's pre-save below because a subdocument has no hooks of its own. A removed
  // category is a tombstone, never spliced out: `activeCategories()` in utils/categories.js is
  // what every reader goes through.
  clientId:  { type: String, default: undefined, trim: true, maxlength: 64 },
  updatedAt: { type: Date, default: undefined },
  syncedAt:  { type: Date, default: undefined },
  deletedAt: { type: Date, default: null },
});

const pendingMemberSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  requestedAt: { type: Date, default: Date.now },
});

const groupSchema = new mongoose.Schema({
  name: String,
  joinCode: String,
  // Every user owns one personal group — it is where their categories live and what scopes their
  // transactions when they are not sharing with anyone. It is a real group so that there is one
  // code path instead of two, but it is not a shareable one: the app hides the join code and the
  // member list for it, and still offers "create or join a group" to someone who only has this.
  isPersonal: { type: Boolean, default: false },
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

groupSchema.pre("save", async function () {
  const now = monotonicNow();
  for (const c of this.categories) {
    if (c.isNew || c.isModified()) {
      if (!c.isModified("updatedAt")) c.updatedAt = now;
      c.syncedAt = now;
    }
  }
});

module.exports = mongoose.model("Group", groupSchema);
