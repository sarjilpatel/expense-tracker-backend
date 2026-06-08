const mongoose = require('mongoose');

const splitEntrySchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount:    { type: Number, required: true, min: 0 },
  settled:   { type: Boolean, default: false },
  settledAt: { type: Date,    default: null },
}, { _id: false });

const splitSchema = new mongoose.Schema({
  groupId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true },
  paidBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User',  required: true },
  title:       { type: String, required: true, trim: true, maxlength: 80 },
  totalAmount: { type: Number, required: true, min: 0.01 },
  currency:    { type: String, enum: ['INR', 'USD', 'EUR', 'GBP', 'AED', 'JPY', 'CAD', 'AUD'], default: 'INR' },
  splits:      { type: [splitEntrySchema], default: [] },
  createdAt:   { type: Date, default: Date.now },
});

module.exports = mongoose.model('Split', splitSchema);
