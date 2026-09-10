const mongoose = require("mongoose");

// A fixed-window counter, keyed `<limit>:<subject>:<window>`. Mongo rather than memory because
// the send limits have to hold across restarts and across however many instances are running —
// express-rate-limit's default store gives neither, and a per-process counter is no limit at all
// once the process recycles between two sends.
const rateLimitSchema = new mongoose.Schema({
    key:   { type: String, required: true, unique: true },
    count: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
});

rateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("RateLimit", rateLimitSchema);
