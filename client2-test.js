const { io } = require("socket.io-client");

const socket = io("http://localhost:5000");

// Register user 2
socket.emit("register", { userId: 2 });

// Listen for messages
socket.on("receiveMessage", (data) => {
    console.log("📥 Client 2 got message:", data);
});
