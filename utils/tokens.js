// Single source of truth for issuing auth tokens. signup, login and googleAuth each had their own
// copy of the two jwt.sign calls, which is how the 365-day refresh lifetime ended up unreviewed in
// three places at once.

const jwt = require("jsonwebtoken");

const ACCESS_TTL  = '1h';

// Was 365d. A stolen refresh token was usable for a year; with rotation on every refresh an
// active user never reaches this, and an inactive one is asked to log in again after a month.
const REFRESH_TTL = '30d';

/**
 * Access token. Short-lived, never revocable — that is what the refresh token's version is for.
 */
function signAccessToken(user) {
    return jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: ACCESS_TTL });
}

/**
 * Refresh token, stamped with the user's current `tokenVersion`. Bumping that field on the user
 * invalidates every refresh token ever issued to them — this is what makes logout and password
 * reset actually lock an attacker out.
 */
function signRefreshToken(user) {
    return jwt.sign(
        { id: user._id, tv: user.tokenVersion || 0 },
        process.env.REFRESH_TOKEN_SECRET,
        { expiresIn: REFRESH_TTL }
    );
}

/** Both tokens, for the three places that start a new session. */
function issueTokens(user) {
    return { token: signAccessToken(user), refreshToken: signRefreshToken(user) };
}

module.exports = { signAccessToken, signRefreshToken, issueTokens, ACCESS_TTL, REFRESH_TTL };
