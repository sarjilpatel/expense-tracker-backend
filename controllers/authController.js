const bcrypt  = require("bcryptjs");
const jwt     = require("jsonwebtoken");
const crypto  = require("crypto");
const { GetObjectCommand }   = require("@aws-sdk/client-s3");
const { getSignedUrl }       = require("@aws-sdk/s3-request-presigner");
const User        = require("../models/User");
const Transaction = require("../models/Transaction");
const Goal        = require("../models/Goal");
const Split       = require("../models/Split");
const Budget      = require("../models/Budget");
const Group       = require("../models/Group");
const { s3Client }                          = require("../middleware/uploadMiddleware");
const { sendPasswordResetEmail, sendVerificationEmail } = require("../utils/mailer");

exports.signup = async (req, res) => {
    try {
        const { name, email, password, timezone } = req.body;

        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ message: "User already exists" });
        }

        const hashed = await bcrypt.hash(password, 10);
        const verificationToken   = crypto.randomBytes(32).toString("hex");
        const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

        const user = await User.create({
            name,
            email,
            password: hashed,
            emailVerificationToken:   verificationToken,
            emailVerificationExpires: verificationExpires,
            timezone: timezone || 'UTC',
        });

        // Send verification email (non-blocking — don't fail signup if email fails)
        sendVerificationEmail(email, verificationToken).catch(err =>
            console.error("Verification email error:", err)
        );

        const userResponse = user.toObject();
        delete userResponse.password;

        const token        = jwt.sign({ id: user._id }, process.env.JWT_SECRET,           { expiresIn: '1h'   });
        const refreshToken = jwt.sign({ id: user._id }, process.env.REFRESH_TOKEN_SECRET, { expiresIn: '365d' });

        res.json({ token, refreshToken, user: userResponse });
    } catch (error) {
        console.error("Signup Error:", error);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.login = async (req, res) => {
    try {
        const { email, password } = req.body;

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(400).json({ message: "Invalid credentials" });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: "Invalid credentials" });
        }

        const userResponse = user.toObject();
        delete userResponse.password;

        const token        = jwt.sign({ id: user._id }, process.env.JWT_SECRET,         { expiresIn: '1h' });
        const refreshToken = jwt.sign({ id: user._id }, process.env.REFRESH_TOKEN_SECRET, { expiresIn: '365d' });

        res.json({ token, refreshToken, user: userResponse });
    } catch (error) {
        console.error("Login Error:", error);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getMe = async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select("-password").populate("groupId");
        res.json(user);
    } catch (error) {
        res.status(500).json({ message: "Server Error" });
    }
};

exports.updateProfile = async (req, res) => {
    try {
        const { name } = req.body;
        const userId = req.user.id;
        const updatedFields = {};

        if (name) updatedFields.name = name;
        if (req.file) {
            updatedFields.profilePhoto    = req.file.location; // public URL (kept for backward-compat)
            updatedFields.profilePhotoKey = req.file.key;      // S3 object key for pre-signed URLs
        }

        const user = await User.findByIdAndUpdate(
            userId,
            { $set: updatedFields },
            { new: true }
        ).select("-password");

        res.json(user);
    } catch (error) {
        console.error("Update Profile Error:", error);
        res.status(500).json({ message: "Failed to update profile" });
    }
};

exports.getProfilePhotoUrl = async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select("profilePhotoKey");
        if (!user?.profilePhotoKey) return res.json({ url: null });

        const command = new GetObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME,
            Key:    user.profilePhotoKey,
        });
        const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 }); // 1 hour
        res.json({ url });
    } catch (error) {
        console.error("Pre-signed URL error:", error);
        res.status(500).json({ message: "Failed to generate photo URL" });
    }
};

exports.deleteAccount = async (req, res) => {
    try {
        const userId  = req.user.id;
        const { password } = req.body;

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: "User not found" });

        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) return res.status(401).json({ message: "Incorrect password" });

        // Schedule deletion 30 days from now instead of immediately deleting
        const deletionScheduledAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        await User.findByIdAndUpdate(userId, { pendingDeletion: true, deletionScheduledAt });

        res.json({
            message: "Account scheduled for deletion",
            deletionScheduledAt,
        });
    } catch (error) {
        res.status(500).json({ message: "Failed to schedule account deletion" });
    }
};

exports.cancelDeletion = async (req, res) => {
    try {
        const userId = req.user.id;
        await User.findByIdAndUpdate(userId, { pendingDeletion: false, deletionScheduledAt: null });
        res.json({ message: "Account deletion cancelled" });
    } catch (error) {
        res.status(500).json({ message: "Failed to cancel deletion" });
    }
};

exports.refreshToken = async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken) return res.status(401).json({ message: "Refresh token required" });

        const decoded = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
        const user = await User.findById(decoded.id);
        if (!user) return res.status(401).json({ message: "User not found" });

        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
        res.json({ token });
    } catch (error) {
        res.status(401).json({ message: "Invalid or expired refresh token" });
    }
};

exports.forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;
        const user = await User.findOne({ email });
        // Always return 200 to prevent email enumeration
        if (!user) return res.json({ message: "If that email exists, a reset link has been sent." });

        const rawToken    = crypto.randomBytes(32).toString("hex");
        const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");

        await User.findByIdAndUpdate(user._id, {
            passwordResetToken:   hashedToken,
            passwordResetExpires: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
        });

        await sendPasswordResetEmail(email, rawToken);
        res.json({ message: "If that email exists, a reset link has been sent." });
    } catch (error) {
        console.error("Forgot password error:", error);
        res.status(500).json({ message: "Failed to send reset email" });
    }
};

exports.resetPassword = async (req, res) => {
    try {
        const { token } = req.params;
        const { password } = req.body;

        const hashedToken = crypto.createHash("sha256").update(token).digest("hex");
        const user = await User.findOne({
            passwordResetToken:   hashedToken,
            passwordResetExpires: { $gt: new Date() },
        });
        if (!user) return res.status(400).json({ message: "Reset link is invalid or has expired." });

        const hashed = await bcrypt.hash(password, 10);
        await User.findByIdAndUpdate(user._id, {
            password:             hashed,
            passwordResetToken:   null,
            passwordResetExpires: null,
        });

        res.json({ message: "Password reset successfully. You can now log in." });
    } catch (error) {
        console.error("Reset password error:", error);
        res.status(500).json({ message: "Failed to reset password" });
    }
};

exports.verifyEmail = async (req, res) => {
    try {
        const { token } = req.params;
        const user = await User.findOne({
            emailVerificationToken:   token,
            emailVerificationExpires: { $gt: new Date() },
        });
        if (!user) return res.status(400).json({ message: "Verification link is invalid or has expired." });

        await User.findByIdAndUpdate(user._id, {
            isEmailVerified:           true,
            emailVerificationToken:    null,
            emailVerificationExpires:  null,
        });

        res.json({ message: "Email verified successfully." });
    } catch (error) {
        res.status(500).json({ message: "Failed to verify email" });
    }
};

exports.resendVerification = async (req, res) => {
    try {
        const userId = req.user.id;
        const user   = await User.findById(userId);
        if (!user)                  return res.status(404).json({ message: "User not found" });
        if (user.isEmailVerified)   return res.json({ message: "Email already verified" });

        const verificationToken   = crypto.randomBytes(32).toString("hex");
        const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await User.findByIdAndUpdate(userId, {
            emailVerificationToken:   verificationToken,
            emailVerificationExpires: verificationExpires,
        });

        await sendVerificationEmail(user.email, verificationToken);
        res.json({ message: "Verification email sent." });
    } catch (error) {
        res.status(500).json({ message: "Failed to resend verification email" });
    }
};

exports.googleAuth = async (req, res) => {
    try {
        const { idToken } = req.body;
        if (!idToken) return res.status(400).json({ message: 'idToken required' });

        const googleRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
        const payload   = await googleRes.json();

        if (!googleRes.ok || payload.error || payload.error_description) {
            return res.status(401).json({ message: 'Invalid Google token' });
        }

        const clientId = process.env.GOOGLE_CLIENT_ID;
        if (clientId && payload.aud !== clientId) {
            return res.status(401).json({ message: 'Token audience mismatch' });
        }

        const { email, name, sub: googleId, picture } = payload;
        if (!email) return res.status(400).json({ message: 'No email in Google token' });

        let user = await User.findOne({ email });
        if (!user) {
            user = await User.create({
                name:            name || email.split('@')[0],
                email,
                password:        crypto.randomBytes(32).toString('hex'),
                isEmailVerified: true,
                googleId,
                profilePhoto:    picture || '',
            });
        } else {
            const updates = {};
            if (!user.isEmailVerified) updates.isEmailVerified = true;
            if (!user.googleId)        updates.googleId        = googleId;
            if (Object.keys(updates).length > 0) {
                await User.findByIdAndUpdate(user._id, updates);
                Object.assign(user, updates);
            }
        }

        const token        = jwt.sign({ id: user._id }, process.env.JWT_SECRET,           { expiresIn: '1h'   });
        const refreshToken = jwt.sign({ id: user._id }, process.env.REFRESH_TOKEN_SECRET, { expiresIn: '365d' });

        const userResponse = user.toObject();
        delete userResponse.password;

        res.json({ token, refreshToken, user: userResponse });
    } catch (error) {
        console.error('Google auth error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

exports.deleteAllData = async (req, res) => {
    try {
        const userId = req.user.id;
        const user   = await User.findById(userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        await Transaction.deleteMany({ userId });
        await Goal.deleteMany({ userId });
        await Budget.deleteMany({ userId });
        await Split.deleteMany({ $or: [{ paidBy: userId }, { 'splits.userId': userId }] });
        if (user.groupId) {
            await Group.updateOne({ _id: user.groupId }, { $pull: { members: userId } });
        }
        await User.findByIdAndDelete(userId);

        res.json({ message: 'All data deleted successfully' });
    } catch (error) {
        console.error('Delete all data error:', error);
        res.status(500).json({ message: 'Failed to delete all data' });
    }
};

exports.updateAiConsent = async (req, res) => {
    try {
        const userId = req.user.id;
        const { aiConsentGiven } = req.body;
        if (typeof aiConsentGiven !== "boolean") {
            return res.status(400).json({ message: "aiConsentGiven must be a boolean" });
        }
        const user = await User.findByIdAndUpdate(
            userId,
            { aiConsentGiven },
            { new: true }
        ).select("-password");
        res.json({ aiConsentGiven: user.aiConsentGiven });
    } catch (error) {
        res.status(500).json({ message: "Failed to update AI consent" });
    }
};