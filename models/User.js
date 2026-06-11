const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
    name: String,
    email: { type: String, unique: true },
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
    // email verification
    isEmailVerified:           { type: Boolean, default: false },
    emailVerificationToken:    { type: String,  default: null  },
    emailVerificationExpires:  { type: Date,    default: null  },
    // password reset
    passwordResetToken:   { type: String, default: null },
    passwordResetExpires: { type: Date,   default: null },
    // Google OAuth
    googleId: { type: String, default: null },
    // AI consent
    aiConsentGiven: { type: Boolean, default: false },
    // timezone (IANA, e.g. "Asia/Kolkata") — used for recurring transaction scheduling
    timezone: { type: String, default: 'UTC' },
});

module.exports = mongoose.model("User", userSchema);