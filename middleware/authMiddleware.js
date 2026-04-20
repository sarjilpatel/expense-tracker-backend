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
        console.error("JWT Verification Error:", error.message);
        return res.status(401).json({ msg: "Invalid or expired token" });
    }
};

module.exports = authMiddleware;