const express = require("express");
const router  = express.Router();
const auth    = require("../middleware/authMiddleware");
const { validateAccount } = require("../middleware/validate");
const {
  getAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
  getTxAccountMap,
  setTxAccount,
  importAccounts,
} = require("../controllers/accountController");

// @route   POST /api/accounts/import
// @desc    Bulk create accounts during guest→server sync; returns a local→server id map
// @access  Private
router.post("/import", auth, importAccounts);

// @route   GET /api/accounts/tx-map
// @desc    { [transactionId]: accountId } for the authenticated user
// @access  Private
// Declared before "/:id" so the literal path is not swallowed by the parameterised one.
router.get("/tx-map", auth, getTxAccountMap);

// @route   PATCH /api/accounts/tx/:id
// @desc    Assign or clear the account on a single transaction
// @access  Private
router.patch("/tx/:id", auth, setTxAccount);

// @route   GET /api/accounts
// @desc    All accounts for the authenticated user
// @access  Private
router.get("/", auth, getAccounts);

// @route   POST /api/accounts
// @desc    Create an account
// @access  Private
router.post("/", auth, validateAccount, createAccount);

// @route   PUT /api/accounts/:id
// @desc    Update an account
// @access  Private
router.put("/:id", auth, validateAccount, updateAccount);

// @route   DELETE /api/accounts/:id
// @desc    Delete an account; its transactions are kept and unassigned
// @access  Private
router.delete("/:id", auth, deleteAccount);

module.exports = router;
