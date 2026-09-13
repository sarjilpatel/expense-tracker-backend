require("dotenv").config();

// Fail fast at boot rather than 500-ing on the first request that needs one of these. Without
// REFRESH_TOKEN_SECRET, jwt.sign throws "secretOrPublicKey must have a value" — so signup, login
// and /auth/refresh all break at runtime while the process happily reports itself as healthy.
for (const name of ["JWT_SECRET", "REFRESH_TOKEN_SECRET", "MONGO_URI"]) {
    if (!process.env[name]) {
        console.error(`FATAL: ${name} is not set in environment variables. Refusing to start.`);
        process.exit(1);
    }
}

// They must differ: sharing one secret makes an access token verify as a refresh token, so a
// leaked 1h access token could be traded for fresh credentials indefinitely.
if (process.env.JWT_SECRET === process.env.REFRESH_TOKEN_SECRET) {
    console.error("FATAL: JWT_SECRET and REFRESH_TOKEN_SECRET must be different values. Refusing to start.");
    process.exit(1);
}

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const connectDB = require("./config/db");
const { computeNextDueDate, localDayOfMonth } = require("./utils/recurrence");
const { runBackup, isBackupConfigured } = require("./utils/backup");

const cron = require("node-cron");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const { notFound, errorHandler } = require("./middleware/errorHandler");
const Transaction = require("./models/Transaction");
const User        = require("./models/User");
const { purgeUser } = require("./utils/purgeUser");
const { purgeTombstones } = require("./utils/tombstones");

const authRoutes        = require("./routes/authRoutes");
const groupRoutes       = require("./routes/groupRoutes");
const transactionRoutes = require("./routes/transactionRoutes");
const budgetRoutes      = require("./routes/budgetRoutes");
const goalRoutes        = require("./routes/goalRoutes");
const tripRoutes        = require("./routes/tripRoutes");
const userRoutes        = require("./routes/userRoutes");
const accountRoutes     = require("./routes/accountRoutes");
const syncRoutes        = require("./routes/syncRoutes");
const attachmentRoutes  = require("./routes/attachmentRoutes");

const app = express();
const server = http.createServer(app);
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : [];

const io = new Server(server, {
    cors: {
        origin: ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : false,
        methods: ["GET", "POST", "PUT", "DELETE"],
        credentials: true,
    }
});

// Security headers first, so they are set even on a response produced by the rate limiter or the
// CORS preflight rather than by a route. Defaults are right for a JSON-only API: nothing here is
// framed, embedded or rendered as HTML.
app.use(helmet());

app.use(cors({
    origin: ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : false,
    credentials: true,
}));
app.use(express.json());
app.set('trust proxy', 1);

// Global rate limiter on /api — 300 requests/minute **per user**, per IP only when there is no
// usable token (W3-01). It was 60/min per IP, and a household group on one router shares an IP:
// three phones on the same Wi-Fi shared one budget, and a tour of the four tabs is ~15 requests.
// The token is verified here with the same secret the auth middleware uses, so a forged one
// cannot buy its own bucket — it falls back to the IP like any anonymous request.
const { rateLimitKey } = require("./utils/rateLimitKey");
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateLimitKey,
    message: { message: "Too many requests, please slow down." },
});
// The sync endpoints sit outside the general limiter with a bucket of their own (W3-09): a push
// is one request per 500 rows and a full pull pages at up to 1,000, so a device catching up after
// a day offline can legitimately make a burst of them — and nothing else runs in that burst.
const syncLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateLimitKey,
    message: { message: "Too many sync requests, please slow down." },
});
app.use('/api/sync', syncLimiter, syncRoutes);
app.use('/api/attachments', syncLimiter, attachmentRoutes);

app.use('/api', apiLimiter);

// Attach io to app so it's accessible in controllers
app.set("io", io);

connectDB();

app.use("/api/auth",         authRoutes);
app.use("/api/group",        groupRoutes);
app.use("/api/transactions", transactionRoutes);
app.use("/api/budgets",      budgetRoutes);
app.use("/api/goals",        goalRoutes);
app.use("/api/trips",        tripRoutes);
app.use("/api/user",         userRoutes);
app.use("/api/accounts",     accountRoutes);

// Verify JWT on every socket connection — reject unauthenticated sockets
io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Authentication required"));
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.data.userId = decoded.id;
        next();
    } catch {
        next(new Error("Invalid or expired token"));
    }
});

io.on("connection", (socket) => {
    socket.on("join_group", async (groupId) => {
        if (!groupId) return;
        try {
            const user = await User.findById(socket.data.userId).select("groupId").lean();
            if (!user || !user.groupId || user.groupId.toString() !== groupId) return;
            socket.join(groupId);
        } catch {
            // silently ignore — client will rely on HTTP for data
        }
    });

    socket.on("disconnect", () => {
        // no-op: nothing sensitive to log
    });
});

app.get("/", (req, res) => {
    res.send("Expense Tracker API with Socket.IO running");
});

// Must stay last: `notFound` catches anything the routers did not match, and `errorHandler` is
// terminal, so a route registered after it would never be reached and an error raised before it
// would fall through to Express's stack-trace-in-HTML default.
app.use(notFound);
app.use(errorHandler);

// Run every hour — generate recurring transactions for any user whose local midnight is within the current hour
cron.schedule("0 * * * *", async () => {
    try {
        const now = new Date();
        // Add 1h buffer to catch any timezone that is at or past local midnight
        const windowEnd = new Date(now.getTime() + 60 * 60 * 1000);
        // deletedAt must be excluded — deleteTransaction is a soft delete, so without this a
        // deleted template kept generating new transactions forever.
        const due = await Transaction.find({
            isRecurring: true,
            deletedAt: null,
            nextDueDate: { $lte: windowEnd },
        });

        // Recurrence maths runs in the owner's calendar (see utils/recurrence.js), so we need
        // their timezone. One lookup for the whole batch rather than a User query per template.
        const timezones = new Map();
        if (due.length > 0) {
            const ownerIds = [...new Set(due.map(t => String(t.userId)))];
            const owners   = await User.find({ _id: { $in: ownerIds } }, { timezone: 1 }).lean();
            for (const o of owners) timezones.set(String(o._id), o.timezone || 'UTC');
        }

        for (const tx of due) {
          // One malformed template must not abort the run for everyone else.
          try {
            const timeZone  = timezones.get(String(tx.userId)) || 'UTC';
            // A monthly series is pinned to the day-of-month it started on, so that one short
            // month doesn't move it permanently: Jan 31 -> Feb 28 -> Mar 31, not -> Mar 28.
            const opts      = { timeZone, anchorDay: localDayOfMonth(tx.date, timeZone) };
            // Advance from the scheduled time, not from `now`. Stepping from the tick time
            // dragged the series onto whatever hour the cron happened to fire, and for a monthly
            // series it re-applied the month-overflow bug on every single run.
            const scheduled = tx.nextDueDate ? new Date(tx.nextDueDate) : now;

            let nextDue = computeNextDueDate(scheduled, tx.recurrenceFrequency, opts);

            // If the server was down long enough to miss occurrences, walk the schedule forward
            // instead of firing once an hour until it catches up. Exactly one occurrence is
            // generated per tick either way — as before — but the series keeps its own clock.
            for (let i = 0; nextDue && nextDue <= now && i < 400; i++) {
                nextDue = computeNextDueDate(nextDue, tx.recurrenceFrequency, opts);
            }

            // Unrecognised frequency — retire the template instead of leaving it to be picked up
            // again on the next tick.
            if (!nextDue) {
                tx.isRecurring = false;
                tx.nextDueDate = null;
                await tx.save();
                continue;
            }

            // The generated occurrence must NOT be recurring itself. Marking it recurring made
            // every occurrence a template in its own right, doubling the count each period.
            const newTx = await Transaction.create({
                amount: tx.amount,
                type: tx.type,
                category: tx.category,
                note: tx.note,
                userId: tx.userId,
                groupId: tx.groupId,
                currency: tx.currency,
                isPrivate: tx.isPrivate,
                // The scheduled time, not the tick time: the 1-hour look-ahead means the cron can
                // fire before the occurrence is actually due, which in some timezones would file
                // it under the previous local day.
                date: scheduled,
                isRecurring: false,
                recurrenceFrequency: null,
                nextDueDate: null,
            });

            // Only the source template advances
            tx.nextDueDate = nextDue;
            await tx.save();

            // Tell the group's devices there is something to pull (W3-22). A signal, not the row:
            // the changes feed is the one source of rows. Solo users have no groupId — calling
            // .toString() on null threw and aborted the whole run, skipping every remaining one.
            if (tx.groupId) io.to(tx.groupId.toString()).emit("group_changed", { groupId: tx.groupId.toString(), by: "server" });
          } catch {
            // Skip this template; the rest of the batch still runs.
          }
        }

    } catch {
        // Cron errors are non-fatal; log count only to avoid leaking data
        if (process.env.NODE_ENV !== 'production') {
            console.error("Cron job error — check server");
        }
    }
});

// Nightly purge — permanently delete accounts whose 30-day grace period has passed
cron.schedule("5 0 * * *", async () => {
    try {
        const now = new Date();
        const due = await User.find({ pendingDeletion: true, deletionScheduledAt: { $lte: now } });
        for (const user of due) {
          // One user failing to purge must not abort the batch — the rest still run, and this
          // user is retried on tomorrow's tick.
          try {
            // Shared with the immediate "Full Reset" endpoint — see utils/purgeUser.js for why
            // this is not written out twice any more.
            await purgeUser(user);
          } catch {
            // Skip this user; partial deletions are re-attempted on the next run.
          }
        }
    } catch {
        if (process.env.NODE_ENV !== 'production') console.error("Account purge cron error");
    }

    // Same tick: tombstones past their 30 days go for good (W3-12).
    try {
        await purgeTombstones();
    } catch {
        if (process.env.NODE_ENV !== 'production') console.error("Tombstone purge cron error");
    }
});

// Nightly database backup to S3. Opt-in: with no BACKUP_S3_BUCKET there is nowhere to put one,
// so the job is not scheduled at all rather than failing every night.
if (isBackupConfigured()) {
    cron.schedule("0 2 * * *", async () => {
        try {
            const out = await runBackup();
            if (process.env.NODE_ENV !== 'production') console.log(out.trim());
        } catch (err) {
            // A failed backup is worth saying out loud in production too — silence here is how you
            // discover months later that there was never anything to restore from. The message is
            // the script's own output, which carries no user data.
            console.error(`Backup failed: ${err.message}`);
        }
    });
} else if (process.env.NODE_ENV !== 'production') {
    console.log("BACKUP_S3_BUCKET not set — nightly backups disabled.");
}

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    if (process.env.NODE_ENV !== 'production') {
        console.log(`Server running on port ${PORT}`);
    }
});