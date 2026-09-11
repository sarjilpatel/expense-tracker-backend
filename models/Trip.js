const mongoose = require("mongoose");

/**
 * A member of a trip. Ad-hoc by design: `name` is all that is required, so a trip can include
 * someone who has no account — which is the whole reason the local TripMaster feature existed and
 * the reason a `Split` (which could only reference real `User` rows in a group) could not absorb
 * it. `userId` is set only when the member *is* an app user, and is what lets that person act on
 * the trip themselves.
 */
const tripMemberSchema = new mongoose.Schema({
  id:     { type: String, required: true },
  name:   { type: String, required: true, trim: true, maxlength: 60 },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
}, { _id: false });

/**
 * Money is stored as INTEGER minor units (paise), never float rupees. The old `Split.totalAmount`
 * was a Number of rupees and the client validated the shares against it with a 0.01 tolerance —
 * i.e. it was known to drift and the tolerance was the workaround. Integers do not drift, and the
 * app's settlement engine (src/utils/settlement.ts) has always worked this way.
 *
 * `sharesMinor` carries an unevenly divided expense. When present it is the whole truth — its keys
 * are the participants and its values the shares — so it cannot contradict `participantIds` or
 * `amountMinor`. That mirrors the engine exactly; see the note on `SettlementExpense`.
 */
const tripExpenseSchema = new mongoose.Schema({
  id:             { type: String, required: true },
  description:    { type: String, required: true, trim: true, maxlength: 80 },
  amountMinor:    { type: Number, required: true, min: 0 },
  paidById:       { type: String, required: true },
  participantIds: { type: [String], default: [] },
  sharesMinor:    { type: Map, of: Number, default: undefined },
  createdAt:      { type: Date, default: Date.now },
}, { _id: false });

/**
 * A payment actually made between two members, as opposed to one the settlement engine suggests.
 *
 * This replaces `Split.splits[].settled`. A boolean per member per split could only ever say "this
 * person's share of this one bill is square", which is not the question anybody asks on a trip —
 * balances net across every expense, so what gets paid back is a transfer between two people, not
 * a share of a line item. Recording transfers also keeps history: un-settling is deleting the
 * record, which is what W1-29 concluded for splits too.
 */
const tripSettlementSchema = new mongoose.Schema({
  id:          { type: String, required: true },
  fromId:      { type: String, required: true },
  toId:        { type: String, required: true },
  amountMinor: { type: Number, required: true, min: 1 },
  settledAt:   { type: Date, default: Date.now },
  recordedBy:  { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
}, { _id: false });

const tripSchema = new mongoose.Schema({
  groupId:  { type: mongoose.Schema.Types.ObjectId, ref: "Group", required: true, index: true },
  // The authority for every mutation, and the direct descendant of `Split.paidBy`: a trip is its
  // owner's record of what is owed, so only they may change it. See the controller.
  ownerId:  { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  name:     { type: String, required: true, trim: true, maxlength: 80 },
  currency: { type: String, enum: ["INR", "USD", "EUR", "GBP", "AED", "JPY", "CAD", "AUD"], default: "INR" },

  members:     { type: [tripMemberSchema],     default: [] },
  expenses:    { type: [tripExpenseSchema],    default: [] },
  settlements: { type: [tripSettlementSchema], default: [] },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Mongoose 9 runs middleware as promises — a `next` callback is no longer passed, so the
// callback form fails at the first save with "next is not a function".
tripSchema.pre("save", async function () {
  this.updatedAt = new Date();
});

module.exports = mongoose.model("Trip", tripSchema);
