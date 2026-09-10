const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const Otp    = require("../models/Otp");

const TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const COST = 10;

// randomInt, not Math.random: six digits is a small enough space that a predictable generator
// would let a code be guessed rather than brute-forced.
const generateCode = () => crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");

// Issue a code for `email`. Any earlier unused code for the same purpose is dropped first, so
// "resend" really means the previous mail stops working — otherwise every resend widens the set
// of live codes and the 5-attempt cap stops meaning anything.
async function issueOtp({ email, purpose, payload = null, requestIp = null }) {
    const code      = generateCode();
    const codeHash  = await bcrypt.hash(code, COST);
    const expiresAt = new Date(Date.now() + TTL_MINUTES * 60 * 1000);

    await Otp.deleteMany({ email, purpose, consumedAt: null });
    await Otp.create({ email, purpose, codeHash, payload, expiresAt, requestIp });

    return { code, expiresAt, ttlMinutes: TTL_MINUTES };
}

// Check a code. Returns { ok: true, payload } or { ok: false, reason, attemptsLeft }, where
// reason is 'invalid' (no live code, or wrong digits), 'expired', or 'exhausted'.
async function verifyOtp({ email, purpose, code }) {
    const otp = await Otp.findOne({ email, purpose, consumedAt: null }).sort({ createdAt: -1 });
    if (!otp) return { ok: false, reason: "invalid", attemptsLeft: 0 };

    if (otp.expiresAt.getTime() <= Date.now()) {
        await Otp.deleteOne({ _id: otp._id });
        return { ok: false, reason: "expired", attemptsLeft: 0 };
    }

    if (otp.attempts >= MAX_ATTEMPTS) {
        await Otp.deleteOne({ _id: otp._id });
        return { ok: false, reason: "exhausted", attemptsLeft: 0 };
    }

    const match = await bcrypt.compare(code, otp.codeHash);
    if (!match) {
        const attempts = otp.attempts + 1;
        // Destroy the code on the last wrong guess rather than leaving a dead row that would
        // answer 'exhausted' — a wrong guess and a spent budget must look the same to a caller.
        if (attempts >= MAX_ATTEMPTS) {
            await Otp.deleteOne({ _id: otp._id });
            return { ok: false, reason: "exhausted", attemptsLeft: 0 };
        }
        await Otp.updateOne({ _id: otp._id }, { $inc: { attempts: 1 } });
        return { ok: false, reason: "invalid", attemptsLeft: MAX_ATTEMPTS - attempts };
    }

    // Single-use, decided by the database: the filter on consumedAt means only one of two
    // concurrent verifications of the same code gets a document back.
    const claimed = await Otp.findOneAndUpdate(
        { _id: otp._id, consumedAt: null },
        { $set: { consumedAt: new Date() } },
    );
    if (!claimed) return { ok: false, reason: "invalid", attemptsLeft: 0 };

    return { ok: true, payload: otp.payload };
}

module.exports = { issueOtp, verifyOtp, generateCode, TTL_MINUTES, MAX_ATTEMPTS };
