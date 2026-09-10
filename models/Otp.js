const mongoose = require("mongoose");

// One short-lived email code. A signup code carries the whole pending account on `payload`, so
// nothing is written to `users` until the address is proven — an unverified row can never exist.
const otpSchema = new mongoose.Schema({
    email:   { type: String, required: true, lowercase: true, trim: true },
    purpose: { type: String, required: true, enum: ["signup", "reset"] },
    // bcrypt of the six digits. The plaintext code exists only in the email: a dump of this
    // collection is worth nothing, and the 10-minute life makes cracking one pointless anyway.
    codeHash:  { type: String, required: true },
    payload:   { type: mongoose.Schema.Types.Mixed, default: null },
    attempts:  { type: Number, default: 0 },
    // Set the moment a correct code is accepted, in the same atomic update that reads it, so a
    // code can be spent exactly once even if two requests arrive together.
    consumedAt: { type: Date, default: null },
    expiresAt:  { type: Date, required: true },
    requestIp:  { type: String, default: null },
}, { timestamps: true });

otpSchema.index({ email: 1, purpose: 1 });
// Mongo sweeps expired codes on its own. verifyOtp still checks the date itself — the TTL monitor
// only runs once a minute, so an expired code is readable for up to a minute after it dies.
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("Otp", otpSchema);
