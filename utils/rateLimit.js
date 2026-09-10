const RateLimit = require("../models/RateLimit");

const MINUTE = 60 * 1000;
const HOUR   = 60 * MINUTE;

// Fixed windows, deliberately coarse. The per-email limits stop a mailbox being buried; the
// per-IP ones stop one client walking a list of addresses. The 60s cooldown is what the resend
// button on the app counts down against — it is enforced here too, because the button is not
// the only way to reach the endpoint.
const LIMITS = {
    otpSendPerEmail:   { max: 5,  windowMs: HOUR },
    otpSendPerIp:      { max: 20, windowMs: HOUR },
    otpResendCooldown: { max: 1,  windowMs: MINUTE },
};

// Count one hit against `name` for `subject`. Returns { allowed, retryAfterSeconds }. One
// upsert-and-increment, so two simultaneous requests cannot both read the count before it moves.
async function consume(name, subject) {
    const limit = LIMITS[name];
    if (!limit) throw new Error(`Unknown rate limit: ${name}`);
    if (!subject) return { allowed: true, retryAfterSeconds: 0 };

    const now       = Date.now();
    const windowNo  = Math.floor(now / limit.windowMs);
    const expiresAt = new Date((windowNo + 1) * limit.windowMs);
    const key       = `${name}:${subject}:${windowNo}`;

    const doc = await RateLimit.findOneAndUpdate(
        { key },
        { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
        { upsert: true, new: true },
    );

    if (doc.count > limit.max) {
        return { allowed: false, retryAfterSeconds: Math.ceil((expiresAt.getTime() - now) / 1000) };
    }
    return { allowed: true, retryAfterSeconds: 0 };
}

// Behind `trust proxy`, req.ip is already the client rather than the load balancer.
const clientIp = (req) => req.ip || req.socket?.remoteAddress || null;

module.exports = { consume, clientIp, LIMITS };
