require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const connectDB = require("./config/db");

const authRoutes = require("./routes/authRoutes");
const groupRoutes = require("./routes/groupRoutes");
const transactionRoutes = require("./routes/transactionRoutes");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
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

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));