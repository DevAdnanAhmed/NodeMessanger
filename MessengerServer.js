const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mysql = require("mysql2/promise");
require("dotenv").config();

const app = express();
const server = http.createServer(app);

// ✅ Enable CORS for external connections
// const io = new Server(server, {
//     cors: {
//         origin: "*", // Allow all origins for testing
//         methods: ["GET", "POST"],
//     },
// });
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
    },
    transports: [ "polling"],
    path: "/socket.io", // 👈 this is the default path
});


// ✅ Database connection pool
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
});

// ✅ Route to test server in browser
app.get("/test", (req, res) => {
    res.send("<h1>✅ Socket.IO server is running successfully!</h1>");
});

// ✅ Store connected users
const connectedUsers = {};

// ✅ Socket.IO events
io.on("connection", (socket) => {
    console.log("🔌 New client connected:", socket.id);

    // Register user with socket
    socket.on("register", ({ userId }) => {
        connectedUsers[userId] = socket.id;
        console.log(`👤 User ${userId} registered with socket ID ${socket.id}`);
    });

    // Send & save message
    socket.on("sendMessage", async ({ roomId, senderId, receiverId, message }) => {
        try {
            // Save message in DB (no socket_message_id)
            await db.query(
                `INSERT INTO chat_messages
                     (chat_room_id, user_id, content, created_at)
                 VALUES (?, ?, ?, NOW())`,
                [roomId || null, senderId, message]
            );

            console.log(`💬 User ${senderId} → User ${receiverId}: ${message}`);

            // Send to receiver if online
            if (connectedUsers[receiverId]) {
                io.to(connectedUsers[receiverId]).emit("receiveMessage", {
                    senderId,
                    receiverId,
                    message,
                    timestamp: new Date(),
                });
            }
            io.emit("receiveMessage", {
                senderId,
                receiverId,
                message,
                timestamp: new Date(),
            });

            // Emit back to sender confirming delivery
            socket.emit("messageSent", {
                receiverId,
                message,
                timestamp: new Date(),
            });
        } catch (err) {
            console.error("❌ DB Error:", err);
            socket.emit("error", { message: "Internal server error." });
        }
    });

    // Handle disconnect
    socket.on("disconnect", () => {
        console.log("❌ Client disconnected:", socket.id);
        for (const [userId, id] of Object.entries(connectedUsers)) {
            if (id === socket.id) {
                delete connectedUsers[userId];
                break;
            }
        }
    });
});

// ✅ Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Socket.IO server running on port ${PORT}`);
});
