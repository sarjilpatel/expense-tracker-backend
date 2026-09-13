const bcrypt  = require("bcryptjs");
const jwt     = require("jsonwebtoken");
const crypto  = require("crypto");
const { GetObjectCommand }   = require("@aws-sdk/client-s3");
const { getSignedUrl }       = require("@aws-sdk/s3-request-presigner");
const User        = require("../models/User");
const { purgeUser } = require("../utils/purgeUser");
const { s3Client }                          = require("../middleware/uploadMiddleware");
const { sendOtpEmail } = require("../utils/mailer");
const { issueOtp, verifyOtp, TTL_MINUTES } = require("../utils/otp");
const { consume, clientIp } = require("../utils/rateLimit");
const { issueTokens, signAccessToken, signRefreshToken } = require("../utils/tokens");
const { isValidTimeZone } = require("../utils/recurrence");
const { ensurePersonalGroup } = require("../utils/personalGroup");
const Otp = require("../models/Otp");

// One place to turn a verifyOtp failure into a response. "Expired" and "exhausted" are worth
// telling the user apart -- both mean "ask for a new code", but only one is their own doing --
// while a wrong code carries the attempts left so the app can warn before the code dies.
function otpFailure(result) {
    if (result.reason === "expired")   return { message: "That code has expired. Request a new one." };
    if (result.reason === "exhausted") return { message: "Too many wrong attempts. Request a new code." };
    return { message: "That code is not right.", attemptsLeft: result.attemptsLeft };
}

// Signup writes nothing. The account rides on the OTP document until the code comes back, so a
// half-finished signup leaves no row behind and an address can never be squatted by someone who
// merely typed it. The reply is the same whether or not the address is already registered --
// otherwise this endpoint answers "does X have an account here?" to anyone who asks.
exports.signup = async (req, res) => {
    try {
        const { name, email, password, timezone } = req.body;
        const ip = clientIp(req);

        const perEmail = await consume("otpSendPerEmail", email);
        const perIp    = await consume("otpSendPerIp", ip);
        if (!perEmail.allowed || !perIp.allowed) {
            const retryAfter = Math.max(perEmail.retryAfterSeconds, perIp.retryAfterSeconds);
            return res.status(429).json({ message: "Too many codes requested. Try again later.", retryAfter });
        }

        const existingUser = await User.findOne({ email });
        console.log(existingUser)
        if (!existingUser) {
            const hashed = await bcrypt.hash(password, 10);
            const { code, ttlMinutes } = await issueOtp({
                email,
                purpose: "signup",
                payload: { name, passwordHash: hashed, timezone: isValidTimeZone(timezone) ? timezone : "UTC" },
                requestIp: ip,
            });
            // Awaited, unlike the old link mail: if the code never leaves the building there is no
            // account to fall back on, so the user has to be told now rather than left waiting.
            await sendOtpEmail(email, code, "signup", ttlMinutes);
        }

        res.json({ message: "If that address can be registered, a code is on its way.", email, expiresInMinutes: TTL_MINUTES });
    } catch (error) {
        console.error("Signup Error:", error);
        res.status(500).json({ message: "Failed to send verification code" });
    }
};

// The other half of signup: a correct code is the only thing that creates the user.
exports.verifySignup = async (req, res) => {
    try {
        const { email, code } = req.body;

        const result = await verifyOtp({ email, purpose: "signup", code });
        if (!result.ok) return res.status(400).json(otpFailure(result));

        const { name, passwordHash, timezone } = result.payload || {};
        if (!passwordHash) {
            return res.status(400).json({ message: "That code is no longer usable. Please sign up again." });
        }

        // Someone may have completed signup on this address between the code being sent and being
        // entered -- including this same user with a second code. The unique index would throw; a
        // plain answer is more useful than a duplicate-key 500.
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(409).json({ message: "That email is already registered. Please log in." });
        }

        const user = await User.create({
            name,
            email,
            password: passwordHash,
            isEmailVerified: true,
            timezone: timezone || "UTC",
        });

        // Categories live on a group, so an account with none had nowhere to keep them and every
        // category screen answered 404. Every user owns a personal group from the moment they exist.
        await ensurePersonalGroup(user);

        const userResponse = user.toObject();
        delete userResponse.password;

        const { token, refreshToken } = issueTokens(user);
        res.json({ token, refreshToken, user: userResponse });
    } catch (error) {
        console.error("Verify signup error:", error);
        res.status(500).json({ message: "Failed to verify code" });
    }
};

// Re-send the current code. A signup resend reuses the pending payload rather than asking for the
// form again, and answers the same way when there is nothing pending -- the silence toward an
// address that already has an account has to hold here too.
exports.resendOtp = async (req, res) => {
    try {
        const { email, purpose } = req.body;
        const ip = clientIp(req);

        const cooldown = await consume("otpResendCooldown", purpose + ":" + email);
        if (!cooldown.allowed) {
            return res.status(429).json({ message: "Please wait before requesting another code.", retryAfter: cooldown.retryAfterSeconds });
        }
        const perEmail = await consume("otpSendPerEmail", email);
        const perIp    = await consume("otpSendPerIp", ip);
        if (!perEmail.allowed || !perIp.allowed) {
            const retryAfter = Math.max(perEmail.retryAfterSeconds, perIp.retryAfterSeconds);
            return res.status(429).json({ message: "Too many codes requested. Try again later.", retryAfter });
        }

        const neutral = { message: "If that address is waiting on a code, a new one is on its way.", expiresInMinutes: TTL_MINUTES };

        if (purpose === "signup") {
            console.log("---------------------")
            const pending = await Otp.findOne({ email, purpose: "signup", consumedAt: null }).sort({ createdAt: -1 });
            if (!pending?.payload) return res.json(neutral);
            const { code, ttlMinutes } = await issueOtp({ email, purpose: "signup", payload: pending.payload, requestIp: ip });
            await sendOtpEmail(email, code, "signup", ttlMinutes);
            return res.json(neutral);
        }
            console.log("33333333333333333333")

        const user = await User.findOne({ email });
        if (user) {
            const { code, ttlMinutes } = await issueOtp({ email, purpose: "reset", requestIp: ip });
            await sendOtpEmail(email, code, "reset", ttlMinutes);
        }
        res.json(neutral);
    } catch (error) {
        console.error("Resend OTP error:", error);
        res.status(500).json({ message: "Failed to resend code" });
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

        // Heals an account that predates personal groups, so the app has a groupId in hand from the
        // login response rather than picking one up later off the first /group/details call.
        await ensurePersonalGroup(user);

        const userResponse = user.toObject();
        delete userResponse.password;

        const { token, refreshToken } = issueTokens(user);

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

        // Tokens issued before the last logout or password reset carry an older version and are
        // rejected here. Tokens minted before this field existed have no `tv` at all; treat that
        // as version 0 so existing sessions keep working across the deploy.
        const tokenVersion = typeof decoded.tv === 'number' ? decoded.tv : 0;
        if (tokenVersion !== (user.tokenVersion || 0)) {
            return res.status(401).json({ message: "Refresh token has been revoked" });
        }

        // Rotate: hand back a fresh refresh token so an active session keeps sliding forward and
        // the 30-day window is measured from last use, not from login. Note this is rotation
        // without reuse detection — revocation is all-or-nothing via tokenVersion.
        res.json({ token: signAccessToken(user), refreshToken: signRefreshToken(user) });
    } catch (error) {
        res.status(401).json({ message: "Invalid or expired refresh token" });
    }
};

// @desc    Revoke every refresh token for the current user
// @route   POST /api/auth/logout
// @access  Private
exports.logout = async (req, res) => {
    try {
        // $inc rather than read-modify-write: two devices logging out at once must not collide.
        await User.updateOne({ _id: req.user.id }, { $inc: { tokenVersion: 1 } });
        res.json({ message: "Logged out" });
    } catch (error) {
        console.error("Logout error:", error);
        res.status(500).json({ message: "Failed to log out" });
    }
};

exports.forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;
        const ip = clientIp(req);

        const perEmail = await consume("otpSendPerEmail", email);
        const perIp    = await consume("otpSendPerIp", ip);
        if (!perEmail.allowed || !perIp.allowed) {
            const retryAfter = Math.max(perEmail.retryAfterSeconds, perIp.retryAfterSeconds);
            return res.status(429).json({ message: "Too many codes requested. Try again later.", retryAfter });
        }

        const user = await User.findOne({ email });
        // Always the same answer, whether or not the address is known.
        if (user) {
            const { code, ttlMinutes } = await issueOtp({ email, purpose: "reset", requestIp: ip });
            await sendOtpEmail(email, code, "reset", ttlMinutes);
        }
        res.json({ message: "If that email exists, a code is on its way.", email, expiresInMinutes: TTL_MINUTES });
    } catch (error) {
        console.error("Forgot password error:", error);
        res.status(500).json({ message: "Failed to send reset code" });
    }
};

exports.resetPassword = async (req, res) => {
    try {
        const { email, code, password } = req.body;

        const result = await verifyOtp({ email, purpose: "reset", code });
        if (!result.ok) return res.status(400).json(otpFailure(result));

        const user = await User.findOne({ email });
        // A correct code for an address with no account can only mean the account went away in the
        // last ten minutes. Nothing to reset, and nothing worth explaining.
        if (!user) return res.status(400).json({ message: "That code is no longer usable." });

        const hashed = await bcrypt.hash(password, 10);
        // Bump tokenVersion: resetting a password after a compromise must log the attacker out.
        // Without this their refresh token stayed valid for the whole of its lifetime.
        await User.findByIdAndUpdate(user._id, {
            $set: { password: hashed },
            $inc: { tokenVersion: 1 },
        });

        res.json({ message: "Password reset successfully. You can now log in." });
    } catch (error) {
        console.error("Reset password error:", error);
        res.status(500).json({ message: "Failed to reset password" });
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

        const { email: rawEmail, name, sub: googleId, picture } = payload;
        if (!rawEmail) return res.status(400).json({ message: 'No email in Google token' });
        // This route has no Joi validator, so it must normalise the address itself — otherwise a
        // Google account with a capitalised address creates a second, duplicate user.
        const email = String(rawEmail).trim().toLowerCase();

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

        // Both branches: a returning Google account created before personal groups existed needs
        // one just as much as a new sign-up does.
        await ensurePersonalGroup(user);

        const { token, refreshToken } = issueTokens(user);

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

        // Shared with the nightly purge cron. This used to delete every shared bill the user
        // merely took part in, which destroyed other members' records; `purgeUser` detaches them
        // from those and deletes only the ones they own.
        await purgeUser(user);

        res.json({ message: 'All data deleted successfully' });
    } catch (error) {
        console.error('Delete all data error:', error);
        res.status(500).json({ message: 'Failed to delete all data' });
    }
};

// @desc    Keep `User.timezone` current with the device
// @route   PATCH /api/auth/timezone
// @access  Private
//
// The zone was captured once at signup and never written again, so a user who moved — or who
// signed up on a device with the wrong clock — kept that zone forever. Since W1-16 it decides when
// their recurring transactions fire, so a stale zone quietly files them on the wrong day.
//
// The app sends this whenever it notices the device disagrees with the stored value, which covers
// both a fresh login and a session that has simply been open across a move. It is deliberately its
// own endpoint rather than a field on login: a long-lived session may never log in again.
exports.updateTimezone = async (req, res) => {
    try {
        const { timezone } = req.body;

        // Everything downstream falls back to UTC on an unknown zone, which is right when reading
        // and wrong when storing — it would leave the user's schedule silently off with nothing to
        // point at. Reject instead, and keep whatever was there.
        if (!isValidTimeZone(timezone)) {
            return res.status(400).json({ message: "Unknown time zone" });
        }

        // Only write when it actually changed: this runs on every app start.
        const result = await User.updateOne(
            { _id: req.user.id, timezone: { $ne: timezone } },
            { timezone },
        );

        res.json({ timezone, updated: result.modifiedCount > 0 });
    } catch (error) {
        console.error("Timezone update error:", error);
        res.status(500).json({ message: "Failed to update time zone" });
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

// @desc    Mirror the device's backup schedule (W3-10)
// @route   PATCH /api/auth/backup-schedule
// @access  Private
const BACKUP_SCHEDULES = ['instant', 'hourly', 'every4h', 'every8h', 'daily', 'manual'];
exports.updateBackupSchedule = async (req, res) => {
    try {
        const { backupSchedule } = req.body;
        if (!BACKUP_SCHEDULES.includes(backupSchedule)) {
            return res.status(400).json({ message: "Unknown backup schedule" });
        }
        await User.updateOne({ _id: req.user.id }, { backupSchedule });
        res.json({ backupSchedule });
    } catch (error) {
        res.status(500).json({ message: "Server error" });
    }
};
