// SocketServer.js - Simple Socket Message Relay
const http = require('http');
const socketIo = require('socket.io');

const server = http.createServer();
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Store users by room
const roomUsers = new Map(); // roomId -> Set of socket.id

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // User joins a room
    socket.on('join_room', (data) => {
        const { room_id } = data;

        // Join socket room
        socket.join(room_id);

        // Track user in room
        if (!roomUsers.has(room_id)) {
            roomUsers.set(room_id, new Set());
        }
        roomUsers.get(room_id).add(socket.id);

        socket.room_id = room_id;
        console.log(`User ${socket.id} joined room: ${room_id}`);
    });

    // Listen for message and emit to room recipients
    socket.on('send_message', (messageData) => {
        const room_id = socket.room_id;

        if (room_id) {
            // Emit message to all users in the room (including sender)
            io.to(room_id).emit('receive_message', messageData);
            console.log(`Message relayed to room ${room_id}:`, messageData.content);
        } else {
            console.log('User not in any room');
        }
    });

    // Handle disconnect
    socket.on('disconnect', () => {
        if (socket.room_id && roomUsers.has(socket.room_id)) {
            roomUsers.get(socket.room_id).delete(socket.id);

            // Clean up empty rooms
            if (roomUsers.get(socket.room_id).size === 0) {
                roomUsers.delete(socket.room_id);
            }
        }
        console.log(`User disconnected: ${socket.id}`);
    });
});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`🚀 ServerSocket running on port ${PORT}`);
    console.log(`📡 Ready to relay messages between room participants`);
});

module.exports = { server, io };