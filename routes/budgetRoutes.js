const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const { getBudgets, setBudget, deleteBudget } = require("../controllers/budgetController");

// @route   GET /api/budgets
// @desc    Get budgets for the group
// @access  Private
router.get("/", auth, getBudgets);

// @route   POST /api/budgets
// @desc    Set or update a budget
// @access  Private
router.post("/", auth, setBudget);

// @route   DELETE /api/budgets/:id
// @desc    Delete a budget
// @access  Private
router.delete("/:id", auth, deleteBudget);

module.exports = router;
