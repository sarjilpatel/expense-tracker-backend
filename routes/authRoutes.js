const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const {
  signup, login, logout, getMe, updateProfile, deleteAccount, cancelDeletion, refreshToken,
  forgotPassword, resetPassword, verifySignup, resendOtp,
  updateAiConsent, getProfilePhotoUrl, googleAuth, updateTimezone, updateBackupSchedule,
} = require("../controllers/authController");
const auth   = require("../middleware/authMiddleware");
const upload = require("../middleware/uploadMiddleware");
const {
  validateSignup, validateLogin, validateForgotPassword, validateResetPassword,
  validateTimezone, validateVerifyOtp, validateResendOtp,
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
router.post("/logout",                     auth,                                 logout);
router.get ("/me",                         auth,                                 getMe);
router.put ("/update-profile",             auth,         upload.single("photo"), updateProfile);
router.delete("/account",                  auth,                                 deleteAccount);
router.post("/account/cancel-deletion",    auth,                                 cancelDeletion);

// Password reset — a six-digit code by mail, then the code and the new password together (W1-32)
router.post("/forgot-password",            resetLimiter, validateForgotPassword, forgotPassword);
router.post("/reset-password",             resetLimiter, validateResetPassword,  resetPassword);

// Email verification. `verify-signup` is what actually creates the account, so it sits under the
// same limiter as signup itself; both are also counted per-address in utils/rateLimit.js, which
// survives a restart in a way this in-memory one does not.
router.post("/verify-signup",              authLimiter,  validateVerifyOtp,      verifySignup);
router.post("/resend-otp",                 authLimiter,  validateResendOtp,      resendOtp);

// Device time zone — sent whenever the app notices it differs from the stored one (W1-30)
router.patch("/timezone",                 auth,         validateTimezone,       updateTimezone);

// AI consent
router.patch("/ai-consent",               auth,                                  updateAiConsent);

// Backup schedule mirror (W3-10)
router.patch("/backup-schedule",          auth,                                  updateBackupSchedule);

// Pre-signed profile photo URL
router.get ("/me/photo-url",              auth,                                  getProfilePhotoUrl);

module.exports = router;
