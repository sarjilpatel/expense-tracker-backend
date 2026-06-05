const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const { signup, login, getMe, updateProfile } = require("../controllers/authController");
const auth = require("../middleware/authMiddleware");
const upload = require("../middleware/uploadMiddleware");

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many attempts, please try again after 15 minutes." }
});

router.post("/signup", authLimiter, signup);
router.post("/login", authLimiter, login);
router.get("/me", auth, getMe);
router.put("/update-profile", auth, upload.single("photo"), updateProfile);

module.exports = router;