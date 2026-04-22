const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const {
  addTransaction,
  getTransactions,
  getAnalytics,
  updateTransaction,
  deleteTransaction,
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

// @route   PUT /api/transactions/:id
// @desc    Update a transaction
// @access  Private
router.put("/:id", auth, updateTransaction);

// @route   DELETE /api/transactions/:id
// @desc    Delete a transaction
// @access  Private
router.delete("/:id", auth, deleteTransaction);

module.exports = router;
