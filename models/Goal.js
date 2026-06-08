const mongoose = require('mongoose');

const goalSchema = new mongoose.Schema({
  groupId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Group',
    required: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 60,
  },
  targetAmount: {
    type: Number,
    required: true,
    min: 1,
  },
  savedAmount: {
    type: Number,
    default: 0,
    min: 0,
  },
  deadline: {
    type: Date,
    default: null,
  },
  icon: {
    type: String,
    default: 'flag-outline',
  },
  color: {
    type: String,
    default: '#6366F1',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('Goal', goalSchema);
