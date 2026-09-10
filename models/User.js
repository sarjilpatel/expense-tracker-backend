const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
    name: String,
    // lowercase normalises writes only — Mongoose 9 does NOT apply it when casting a query
    // filter, so every lookup must lowercase the value itself (Joi does this on the validated
    // auth routes; googleAuth does it inline).
    email: { type: String, unique: true, lowercase: true, trim: true },
    password: String,
    profilePhoto:    { type: String, default: "" }, // kept for backward-compat
    profilePhotoKey: { type: String, default: "" }, // S3 object key for pre-signed URLs
    groupId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Group",
        default: null
    },
    pendingDeletion:     { type: Boolean, default: false },
    deletionScheduledAt: { type: Date,    default: null  },
    // Always true for a password account: a row is only written once the emailed code has been
    // entered (W1-32), so an unverified one cannot exist. Kept because Google accounts arrive
    // verified by a different route and something has to record that.
    isEmailVerified: { type: Boolean, default: false },
    // Bumped on logout and on password reset. Every refresh token carries the version it was
    // issued under, so incrementing this invalidates all of a user's refresh tokens at once.
    tokenVersion: { type: Number, default: 0 },
    // Google OAuth
    googleId: { type: String, default: null },
    // AI consent
    aiConsentGiven: { type: Boolean, default: false },
    // IANA zone, e.g. "Asia/Kolkata". Captured from the device at signup and used by
    // utils/recurrence.js so that "monthly" means the same day next month where the user lives.
    timezone: { type: String, default: 'UTC' },
});

module.exports = mongoose.model("User", userSchema);