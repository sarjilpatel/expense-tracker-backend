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
  // Keyed hashes of the note's words, for search — the note itself is AES-GCM ciphertext and can
  // never be matched against. Written by utils/fieldCrypto.js `noteTokens`; empty when
  // FIELD_ENCRYPTION_KEY is unset, because a plaintext note is searched with a plain regex instead.
  // `select: false` keeps the token list off every response: it is derived from the note, and there
  // is no reason for a client to ever see it.
  noteTokens: {
    type: [String],
    default: undefined,
    select: false,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: [true, "User ID is required"],
  },
  groupId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Group",
    default: null,
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
  isPrivate: {
    type: Boolean,
    default: false,
  },
  deletedAt: {
    type: Date,
    default: null,
  },
  // Which of the user's accounts this came out of / went into. Null means unassigned — the app
  // has always allowed a transaction with no account, and every pre-existing row is in that state.
  accountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Account",
    default: null,
  },
});

// The text index that used to be here covered `note`, which is ciphertext — it indexed base64
// blobs that no query could ever match, and nothing used `$text` in the first place. Replaced by
// the blind index below. An existing deployment still has the old one; drop it once with
// `db.transactions.dropIndex('note_text_category_text')`.
transactionSchema.index({ noteTokens: 1 });
// getTxAccountMap reads every assigned row for one user; without this it is a full collection scan.
transactionSchema.index({ userId: 1, accountId: 1 });

module.exports = mongoose.model("Transaction", transactionSchema);
