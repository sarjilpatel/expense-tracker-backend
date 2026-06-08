require("dotenv").config();

if (!process.env.JWT_SECRET) {
    console.error("FATAL: JWT_SECRET is not set in environment variables. Refusing to start.");
    process.exit(1);
}

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const connectDB = require("./config/db");

const cron = require("node-cron");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const Transaction = require("./models/Transaction");
const User        = require("./models/User");
const Goal        = require("./models/Goal");
const Split       = require("./models/Split");
const Budget      = require("./models/Budget");
const Group       = require("./models/Group");

const authRoutes = require("./routes/authRoutes");
const groupRoutes = require("./routes/groupRoutes");
const transactionRoutes = require("./routes/transactionRoutes");
const budgetRoutes = require("./routes/budgetRoutes");
const goalRoutes  = require("./routes/goalRoutes");
const splitRoutes = require("./routes/splitRoutes");

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

app.use(cors({
    origin: ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : false,
    credentials: true,
}));
app.use(express.json());
app.set('trust proxy', 1);

// Global rate limiter — 60 requests/minute per IP across all /api routes
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many requests, please slow down." },
});
app.use('/api', apiLimiter);

// Attach io to app so it's accessible in controllers
app.set("io", io);

connectDB();

app.use("/api/auth", authRoutes);
app.use("/api/group", groupRoutes);
app.use("/api/transactions", transactionRoutes);
app.use("/api/budgets", budgetRoutes);
app.use("/api/goals",  goalRoutes);
app.use("/api/splits", splitRoutes);

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

// Run every hour — generate recurring transactions for any user whose local midnight is within the current hour
cron.schedule("0 * * * *", async () => {
    try {
        const now = new Date();
        // Add 1h buffer to catch any timezone that is at or past local midnight
        const windowEnd = new Date(now.getTime() + 60 * 60 * 1000);
        const due = await Transaction.find({ isRecurring: true, nextDueDate: { $lte: windowEnd } });

        for (const tx of due) {
            const newTx = await Transaction.create({
                amount: tx.amount,
                type: tx.type,
                category: tx.category,
                note: tx.note,
                userId: tx.userId,
                groupId: tx.groupId,
                date: now,
                isRecurring: true,
                recurrenceFrequency: tx.recurrenceFrequency,
                nextDueDate: computeNextDueDate(now, tx.recurrenceFrequency),
            });

            // Update nextDueDate on the source template transaction
            tx.nextDueDate = computeNextDueDate(now, tx.recurrenceFrequency);
            await tx.save();

            // Notify group via socket
            io.to(tx.groupId.toString()).emit("new_transaction", newTx);
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
            const userId = user._id;
            await Transaction.deleteMany({ userId });
            await Goal.deleteMany({ userId });
            await Budget.deleteMany({ groupId: user.groupId });
            await Split.updateMany({ 'splits.userId': userId }, { $pull: { splits: { userId } } });
            await Split.deleteMany({ paidBy: userId });
            if (user.groupId) {
                await Group.updateOne({ _id: user.groupId }, { $pull: { members: userId } });
            }
            await User.findByIdAndDelete(userId);
        }
    } catch {
        if (process.env.NODE_ENV !== 'production') console.error("Account purge cron error");
    }
});

function computeNextDueDate(from, frequency) {
    const d = new Date(from);
    if (frequency === 'daily') d.setDate(d.getDate() + 1);
    else if (frequency === 'weekly') d.setDate(d.getDate() + 7);
    else if (frequency === 'monthly') d.setMonth(d.getMonth() + 1);
    return d;
}

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    if (process.env.NODE_ENV !== 'production') {
        console.log(`Server running on port ${PORT}`);
    }
});