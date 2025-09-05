const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mysql = require("mysql2/promise");
require("dotenv").config();

const app = express();
const server = http.createServer(app);

// ✅ Enable JSON & URL-encoded parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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


app.post("/send-notification", async (req, res) => {
    try {
        console.log("Received body:", req.body); // Debugging

        const {userId, title, data} = req.body;

        // ✅ Validate inputs
        if (!userId || !data) {
            return res.status(400).json({
                success: false,
                message: "userId and data are required",
            });
        }

        // ✅ Check if user is connected
        const socketId = connectedUsers[userId];
        console.log("Socket ID:", socketId);

        if (socketId) {
            // ✅ Emit notification
            io.to(socketId).emit("notification", {
                title: title || "New Notification",
                data,
                timestamp: new Date(),
            });

            return res.status(200).json({
                success: true,
                message: `Notification sent to user ${userId}`,
            });
        } else {
            return res.status(200).json({
                success: true,
                message: `User ${userId} is offline, notification not delivered`,
            });
        }
    } catch (error) {
        console.error("❌ Error sending notification:", error);
        return res.status(500).json({
            success: false,
            message: "Internal Server Error",
            error: error.message,
        });
    }
});

app.post("/send-chat", async (req, res) => {
    try {
        console.log("📩 Received chat body:", req.body);

        const { socketId, senderId, senderName, message ,profile_img} = req.body;

        // ✅ Validate inputs
        if (!socketId || !senderId || !senderName || !message) {
            return res.status(400).json({
                success: false,
                message: "socketId, senderId, senderName, and message are required",
            });
        }

        // ✅ Check if receiver is connected
        if (connectedUsers && Object.values(connectedUsers).includes(socketId)) {
            // ✅ Emit the real-time chat event
            io.to(socketId).emit("new-chat", {
                senderId,
                senderName,
                profile_img,
                message,
                timestamp: new Date(),
            });

            console.log(`💬 Chat sent to ${socketId} from ${senderName} (${senderId})`);

            return res.status(200).json({
                success: true,
                message: "Chat message sent successfully",
            });
        } else {
            console.warn(`⚠️ Receiver with socketId ${socketId} is offline`);
            return res.status(200).json({
                success: true,
                message: "User is offline, chat not delivered",
            });
        }
    } catch (error) {
        console.error("❌ Error sending chat:", error);
        return res.status(500).json({
            success: false,
            message: "Internal Server Error",
            error: error.message,
        });
    }
});




// ✅ Store connected users
const connectedUsers = {};

// ✅ Socket.IO events
io.on("connection", (socket) => {
    console.log("🔌 New client connected:", socket.id);

    // Register user with socket
    socket.on("register", async ({ userId }) => {
        console.log("Registering user:", userId);
        console.log("Socket ID:", socket.id);
        connectedUsers[userId] = socket.id;

        // Update the user's socket_id in the database
        try {
            await db.query(
                `UPDATE collaborators SET socket_id = ? WHERE user_id = ?`,
                [socket.id, userId]
            );
            console.log(`User ${userId}'s socket_id updated in the database`);
        } catch (error) {
            console.error("Error updating socket_id:", error);
        }

        console.log(`👤 User ${userId} registered with socket ID ${socket.id}`);
    });

    // Handle typing indicator
    socket.on("typing", (data) => {
        console.log(`✍️ User ${data.userId} is typing...`);
        // Broadcast to all except the sender
        io.to(connectedUsers[data.userId]).emit("showTyping", {
            userId: data.userId,
            isTyping: true,
        });
    });

    // Optional: handle stop typing
    socket.on("stopTyping", (data) => {
        io.to(connectedUsers[data.userId]).emit("showTyping", {
            userId: data.userId,
            isTyping: false,
        });
    });
    
    // Send & save message
    socket.on("sendMessage", async ({ socketId, roomId, senderId, receiverId, message }) => {
        try {
            console.log("📩 Received message body:",  socketId, roomId, senderId, receiverId, message );
            // if (!socketId || !senderId || !receiverId || !message ||!roomId) {
            //     console.log("validation failed");
            //     return ;
            // }
            // Save message in DB
            await db.query(
                `INSERT INTO chat_messages
                     (chat_room_id, user_id, content, created_at)
                 VALUES (?, ?, ?, NOW())`,
                [roomId || null, senderId, message]
            );

            console.log(`💬 User ${senderId} → User ${receiverId} having socketId ${connectedUsers[receiverId]}: ${message}`);
            console.log(connectedUsers[receiverId]);

            // Send only to the given socketId (receiver)
            if (socketId) {
                io.to(connectedUsers[receiverId]).emit("receiveMessage", {
                    senderId,
                    receiverId,
                    message,
                    timestamp: new Date(),
                });
            }

            // // Optionally, confirm to sender
            // socket.emit("messageSent", {
            //     receiverId,
            //     message,
            //     timestamp: new Date(),
            // });

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
