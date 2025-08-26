const { io } = require("socket.io-client");

// Connect to socket server
const socket = io("http://localhost:5000", {
    transports: ["websocket"], // Force WebSocket for better performance
});

// Register user 1 when connected
socket.on("connect", () => {
    console.log("✅ Connected to socket server:", socket.id);

    // Register user 1 on server
    socket.emit("register", { userId: 1 });
});

// Send a message to user 2 after 2 seconds
setTimeout(() => {
    const socketMessageId = "Asdfa"; // Generate a unique message ID

    socket.emit("sendMessage", {
        socketMessageId,  // Unique message ID for tracking
        senderId: 1,      // Current user ID
        receiverId: 2,    // Target user ID
        message: "Hello user 2 👋", // Message content
    });

    console.log(`📤 Sending message to user 2 → ID: ${socketMessageId}`);
}, 2000);

// Confirm message sent
socket.on("messageSent", (data) => {
    console.log("✅ Message successfully sent:", data);
});

// Listen for received messages
socket.on("receiveMessage", (data) => {
    console.log("📩 New message received:", data);
});

// Listen for errors
socket.on("error", (err) => {
    console.error("❌ Error:", err.message);
});

// Handle disconnection
socket.on("disconnect", () => {
    console.log("⚠️ Disconnected from server");
});
