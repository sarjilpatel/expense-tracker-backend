const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const {
  addTransaction,
  getTransactions,
  getAnalytics,
} = require("../controllers/transactionController");

// @route   POST /api/transactions
// @desc    Add a new transaction
// @access  Private
router.post("/", auth, addTransaction);

// @route   GET /api/transactions
// @desc    Get all transactions for the user's group
// @access  Private
router.get("/", auth, getTransactions);

// @route   GET /api/transactions/analytics
// @desc    Get transaction analytics (summary + category breakdown)
// @access  Private
router.get("/analytics", auth, getAnalytics);

module.exports = router;
