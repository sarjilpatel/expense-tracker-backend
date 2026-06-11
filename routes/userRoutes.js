const express = require("express");
const router  = express.Router();
const auth    = require("../middleware/authMiddleware");
const { deleteAllData } = require("../controllers/authController");

// @route   DELETE /api/user/all-data
// @desc    Immediately delete all user data + account (Full Reset)
// @access  Private
router.delete("/all-data", auth, deleteAllData);

module.exports = router;
