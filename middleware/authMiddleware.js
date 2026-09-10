const jwt = require("jsonwebtoken");

const authMiddleware = (req, res, next) => {
    let token = req.headers.authorization;

    if (!token) {
        return res.status(401).json({ msg: "No authorization token" });
    }

    // Support 'Bearer <token>' format sent by the frontend
    if (token.startsWith('Bearer ')) {
        token = token.slice(7);
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        // An expired token is the ordinary end of a one-hour session: every active client produces
        // one every hour, and logging that in production buries everything else. A malformed or
        // wrongly-signed token is not routine — that is someone tampering — so it keeps its line.
        // The token itself is never logged either way; it is a live credential until it expires.
        if (error.name !== "TokenExpiredError" || process.env.NODE_ENV !== "production") {
            console.warn(`[auth] ${error.name} on ${req.method} ${req.originalUrl}`);
        }
        return res.status(401).json({ msg: "Invalid or expired token" });
    }
};

module.exports = authMiddleware;