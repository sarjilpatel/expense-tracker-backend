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
const Transaction = require("./models/Transaction");

const authRoutes = require("./routes/authRoutes");
const groupRoutes = require("./routes/groupRoutes");
const transactionRoutes = require("./routes/transactionRoutes");
const budgetRoutes = require("./routes/budgetRoutes");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST", "PUT", "DELETE"]
    }
});

app.use(cors());
app.use(express.json());

// Attach io to app so it's accessible in controllers
app.set("io", io);

connectDB();

app.use("/api/auth", authRoutes);
app.use("/api/group", groupRoutes);
app.use("/api/transactions", transactionRoutes);
app.use("/api/budgets", budgetRoutes);

io.on("connection", (socket) => {
    console.log("Socket connected:", socket.id);

    socket.on("join_group", (groupId) => {
        if (groupId) {
            socket.join(groupId);
            console.log(`Socket ${socket.id} joined room: ${groupId}`);
        }
    });

    socket.on("disconnect", () => {
        console.log("Socket disconnected:", socket.id);
    });
});

app.get("/", (req, res) => {
    res.send("Expense Tracker API with Socket.IO running");
});

// Run every day at midnight to generate due recurring transactions
cron.schedule("0 0 * * *", async () => {
    try {
        const now = new Date();
        const due = await Transaction.find({ isRecurring: true, nextDueDate: { $lte: now } });

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

        if (due.length > 0) {
            console.log(`Cron: generated ${due.length} recurring transactions`);
        }
    } catch (err) {
        console.error("Cron job error:", err);
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
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));