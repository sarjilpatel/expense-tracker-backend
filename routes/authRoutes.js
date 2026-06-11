const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const {
  signup, login, getMe, updateProfile, deleteAccount, cancelDeletion, refreshToken,
  forgotPassword, resetPassword, verifyEmail, resendVerification,
  updateAiConsent, getProfilePhotoUrl, googleAuth,
} = require("../controllers/authController");
const auth   = require("../middleware/authMiddleware");
const upload = require("../middleware/uploadMiddleware");
const {
  validateSignup, validateLogin, validateForgotPassword, validateResetPassword,
} = require("../middleware/validate");

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many attempts, please try again after 15 minutes." }
});

const resetLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5,
    message: { message: "Too many reset attempts, please try again in an hour." }
});

router.post("/google",                     authLimiter,                          googleAuth);
router.post("/signup",                     authLimiter,  validateSignup,         signup);
router.post("/login",                      authLimiter,  validateLogin,          login);
router.post("/refresh",                    refreshToken);
router.get ("/me",                         auth,                                 getMe);
router.put ("/update-profile",             auth,         upload.single("photo"), updateProfile);
router.delete("/account",                  auth,                                 deleteAccount);
router.post("/account/cancel-deletion",    auth,                                 cancelDeletion);

// Password reset
router.post("/forgot-password",            resetLimiter, validateForgotPassword, forgotPassword);
router.post("/reset-password/:token",      resetLimiter, validateResetPassword,  resetPassword);

// Email verification
router.get ("/verify-email/:token",                                              verifyEmail);
router.post("/resend-verification",        auth,                                 resendVerification);

// AI consent
router.patch("/ai-consent",               auth,                                  updateAiConsent);

// Pre-signed profile photo URL
router.get ("/me/photo-url",              auth,                                  getProfilePhotoUrl);

module.exports = router;
