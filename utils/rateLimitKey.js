const jwt = require("jsonwebtoken");
const { ipKeyGenerator } = require("express-rate-limit");

/**
 * The bucket a request counts against: the user id from a *verified* bearer token, or the client
 * IP (IPv6 collapsed to its /56 by express-rate-limit's helper) when there is none. Verification,
 * not just decoding, is deliberate — a made-up token must not earn a fresh bucket.
 */
function rateLimitKey(req) {
    const header = req.headers.authorization;
    if (header && header.startsWith("Bearer ")) {
        try {
            const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
            if (decoded && decoded.id) return `user:${decoded.id}`;
        } catch {
            // expired, malformed or forged — anonymous bucket
        }
    }
    return `ip:${ipKeyGenerator(req.ip || "")}`;
}

module.exports = { rateLimitKey };
