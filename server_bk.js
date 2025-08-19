const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*", // Allow all origins for external access
        methods: ["GET", "POST"],
        credentials: true
    }
});

// Security and performance middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            connectSrc: ["'self'", "ws:", "wss:", "*"] // Allow external connections
        }
    }
}));
app.use(cors());
app.use(compression());
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Store connected users and rooms
const users = new Map();
const rooms = new Map();
const messageHistory = new Map(); // Store recent messages per room

// Configuration
const MAX_MESSAGE_HISTORY = 50; // Keep last 50 messages per room
const MAX_USERNAME_LENGTH = 20;
const MAX_MESSAGE_LENGTH = 500;
const MAX_ROOM_NAME_LENGTH = 30;

// Utility functions
const sanitizeInput = (input) => {
    return input.trim().substring(0, MAX_MESSAGE_LENGTH);
};

const isValidUsername = (username) => {
    return username &&
        username.length <= MAX_USERNAME_LENGTH &&
        /^[a-zA-Z0-9_-]+$/.test(username);
};

const isValidRoomName = (roomName) => {
    return roomName &&
        roomName.length <= MAX_ROOM_NAME_LENGTH &&
        /^[a-zA-Z0-9_-]+$/.test(roomName);
};

const addToMessageHistory = (room, message) => {
    if (!messageHistory.has(room)) {
        messageHistory.set(room, []);
    }

    const history = messageHistory.get(room);
    history.push(message);

    // Keep only recent messages
    if (history.length > MAX_MESSAGE_HISTORY) {
        history.shift();
    }
};

const getMessageHistory = (room) => {
    return messageHistory.get(room) || [];
};

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id} at ${new Date().toISOString()}`);

    socket.on('join', (userData) => {
        try {
            const { username, room = 'general' } = userData;

            // Validate input
            if (!isValidUsername(username)) {
                socket.emit('error', {
                    message: 'Invalid username. Use only letters, numbers, hyphens, and underscores (max 20 chars)'
                });
                return;
            }

            if (!isValidRoomName(room)) {
                socket.emit('error', {
                    message: 'Invalid room name. Use only letters, numbers, hyphens, and underscores (max 30 chars)'
                });
                return;
            }

            // Check if username is already taken
            const existingUser = Array.from(users.values())
                .find(user => user.username.toLowerCase() === username.toLowerCase());

            if (existingUser) {
                socket.emit('error', {
                    message: 'Username already taken. Please choose another one.'
                });
                return;
            }

            // Store user data
            users.set(socket.id, {
                username,
                room,
                socketId: socket.id,
                joinedAt: new Date().toISOString()
            });

            // Join the room
            socket.join(room);

            // Add user to room tracking
            if (!rooms.has(room)) {
                rooms.set(room, new Set());
            }
            rooms.get(room).add(socket.id);

            // Send message history to new user
            const history = getMessageHistory(room);
            socket.emit('message_history', history);

            // Notify user they joined
            socket.emit('joined', {
                room,
                message: `Welcome to ${room}!`,
                userCount: rooms.get(room).size
            });

            // Notify others in room
            const joinMessage = {
                id: `system_${Date.now()}`,
                type: 'system',
                content: `${username} joined the room`,
                room,
                timestamp: new Date().toISOString()
            };

            socket.to(room).emit('user_joined', joinMessage);
            addToMessageHistory(room, joinMessage);

            // Send updated user list to room
            const roomUsers = Array.from(rooms.get(room) || [])
                .map(id => users.get(id))
                .filter(user => user);
            io.to(room).emit('users_update', roomUsers);

            console.log(`${username} joined room: ${room}`);

        } catch (error) {
            console.error('Error in join handler:', error);
            socket.emit('error', { message: 'Failed to join room' });
        }
    });

    socket.on('send_message', (messageData) => {
        try {
            const user = users.get(socket.id);
            if (!user) {
                socket.emit('error', { message: 'User not authenticated' });
                return;
            }

            const content = sanitizeInput(messageData.content);
            if (!content) {
                socket.emit('error', { message: 'Message cannot be empty' });
                return;
            }

            const message = {
                id: `msg_${Date.now()}_${socket.id}`,
                username: user.username,
                content,
                room: user.room,
                timestamp: new Date().toISOString(),
                socketId: socket.id,
                type: 'message'
            };

            // Send message to all users in the room
            io.to(user.room).emit('receive_message', message);

            // Add to message history
            addToMessageHistory(user.room, message);

            console.log(`Message from ${user.username} in ${user.room}: ${content.substring(0, 50)}${content.length > 50 ? '...' : ''}`);

        } catch (error) {
            console.error('Error in send_message handler:', error);
            socket.emit('error', { message: 'Failed to send message' });
        }
    });

    socket.on('send_private_message', (data) => {
        try {
            const sender = users.get(socket.id);
            if (!sender) {
                socket.emit('error', { message: 'User not authenticated' });
                return;
            }

            const { targetUsername, content } = data;
            const sanitizedContent = sanitizeInput(content);

            if (!sanitizedContent) {
                socket.emit('error', { message: 'Private message cannot be empty' });
                return;
            }

            // Find target user
            const targetUser = Array.from(users.values())
                .find(user => user.username.toLowerCase() === targetUsername.toLowerCase());

            if (targetUser) {
                const privateMessage = {
                    id: `pm_${Date.now()}_${socket.id}`,
                    from: sender.username,
                    to: targetUsername,
                    content: sanitizedContent,
                    timestamp: new Date().toISOString(),
                    isPrivate: true,
                    type: 'private'
                };

                // Send to target user
                io.to(targetUser.socketId).emit('receive_private_message', privateMessage);

                // Send confirmation to sender
                socket.emit('private_message_sent', privateMessage);

                console.log(`Private message from ${sender.username} to ${targetUsername}`);
            } else {
                socket.emit('error', { message: 'User not found or offline' });
            }

        } catch (error) {
            console.error('Error in send_private_message handler:', error);
            socket.emit('error', { message: 'Failed to send private message' });
        }
    });

    socket.on('typing', () => {
        try {
            const user = users.get(socket.id);
            if (user) {
                socket.to(user.room).emit('user_typing', {
                    username: user.username,
                    isTyping: true
                });
            }
        } catch (error) {
            console.error('Error in typing handler:', error);
        }
    });

    socket.on('stop_typing', () => {
        try {
            const user = users.get(socket.id);
            if (user) {
                socket.to(user.room).emit('user_typing', {
                    username: user.username,
                    isTyping: false
                });
            }
        } catch (error) {
            console.error('Error in stop_typing handler:', error);
        }
    });

    socket.on('change_room', (newRoom) => {
        try {
            const user = users.get(socket.id);
            if (!user) {
                socket.emit('error', { message: 'User not authenticated' });
                return;
            }

            if (!isValidRoomName(newRoom)) {
                socket.emit('error', {
                    message: 'Invalid room name. Use only letters, numbers, hyphens, and underscores (max 30 chars)'
                });
                return;
            }

            const oldRoom = user.room;

            // Leave old room
            socket.leave(oldRoom);
            if (rooms.has(oldRoom)) {
                rooms.get(oldRoom).delete(socket.id);
                if (rooms.get(oldRoom).size === 0) {
                    rooms.delete(oldRoom);
                    // Clean up message history for empty rooms after some time
                    setTimeout(() => {
                        if (!rooms.has(oldRoom)) {
                            messageHistory.delete(oldRoom);
                        }
                    }, 300000); // 5 minutes
                }
            }

            // Join new room
            socket.join(newRoom);
            user.room = newRoom;

            if (!rooms.has(newRoom)) {
                rooms.set(newRoom, new Set());
            }
            rooms.get(newRoom).add(socket.id);

            // Send message history to user
            const history = getMessageHistory(newRoom);
            socket.emit('message_history', history);

            // Notify old room
            const leftMessage = {
                id: `system_${Date.now()}`,
                type: 'system',
                content: `${user.username} left the room`,
                room: oldRoom,
                timestamp: new Date().toISOString()
            };
            socket.to(oldRoom).emit('user_left', leftMessage);
            addToMessageHistory(oldRoom, leftMessage);

            // Update old room user list
            const oldRoomUsers = Array.from(rooms.get(oldRoom) || [])
                .map(id => users.get(id)).filter(u => u);
            io.to(oldRoom).emit('users_update', oldRoomUsers);

            // Notify new room
            const joinedMessage = {
                id: `system_${Date.now()}`,
                type: 'system',
                content: `${user.username} joined the room`,
                room: newRoom,
                timestamp: new Date().toISOString()
            };
            socket.to(newRoom).emit('user_joined', joinedMessage);
            addToMessageHistory(newRoom, joinedMessage);

            // Update new room user list
            const newRoomUsers = Array.from(rooms.get(newRoom) || [])
                .map(id => users.get(id)).filter(u => u);
            io.to(newRoom).emit('users_update', newRoomUsers);

            // Confirm to user
            socket.emit('room_changed', {
                room: newRoom,
                userCount: rooms.get(newRoom).size
            });

            console.log(`${user.username} moved from ${oldRoom} to ${newRoom}`);

        } catch (error) {
            console.error('Error in change_room handler:', error);
            socket.emit('error', { message: 'Failed to change room' });
        }
    });

    socket.on('get_rooms', () => {
        try {
            const roomList = Array.from(rooms.keys()).map(room => ({
                name: room,
                userCount: rooms.get(room).size
            }));
            socket.emit('rooms_list', roomList);
        } catch (error) {
            console.error('Error in get_rooms handler:', error);
        }
    });

    socket.on('get_room_users', (room) => {
        try {
            const roomUsers = Array.from(rooms.get(room) || [])
                .map(id => users.get(id)).filter(u => u);
            socket.emit('room_users', { room, users: roomUsers });
        } catch (error) {
            console.error('Error in get_room_users handler:', error);
        }
    });

    socket.on('disconnect', (reason) => {
        try {
            const user = users.get(socket.id);

            if (user) {
                const { username, room } = user;

                // Remove from room
                if (rooms.has(room)) {
                    rooms.get(room).delete(socket.id);
                    if (rooms.get(room).size === 0) {
                        rooms.delete(room);
                        // Clean up message history for empty rooms after some time
                        setTimeout(() => {
                            if (!rooms.has(room)) {
                                messageHistory.delete(room);
                            }
                        }, 300000); // 5 minutes
                    }
                }

                // Remove user
                users.delete(socket.id);

                // Notify room
                const leftMessage = {
                    id: `system_${Date.now()}`,
                    type: 'system',
                    content: `${username} left the room`,
                    room,
                    timestamp: new Date().toISOString()
                };
                socket.to(room).emit('user_left', leftMessage);
                addToMessageHistory(room, leftMessage);

                // Update user list for room
                const roomUsers = Array.from(rooms.get(room) || [])
                    .map(id => users.get(id)).filter(u => u);
                io.to(room).emit('users_update', roomUsers);

                console.log(`${username} disconnected from ${room} (${reason}) at ${new Date().toISOString()}`);
            } else {
                console.log(`User disconnected: ${socket.id} (${reason}) at ${new Date().toISOString()}`);
            }
        } catch (error) {
            console.error('Error in disconnect handler:', error);
        }
    });
});

// Routes
app.get('/', (req, res) => {
    res.json({
        status: 'Socket.IO Chat Server Running',
        timestamp: new Date().toISOString(),
        connectedUsers: users.size,
        activeRooms: rooms.size
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        connectedUsers: users.size,
        activeRooms: rooms.size
    });
});

// API endpoints
app.get('/api/stats', (req, res) => {
    const stats = {
        connectedUsers: users.size,
        activeRooms: rooms.size,
        rooms: Array.from(rooms.keys()).map(room => ({
            name: room,
            userCount: rooms.get(room).size
        })),
        totalMessages: Array.from(messageHistory.values())
            .reduce((total, history) => total + history.length, 0),
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    };
    res.json(stats);
});

app.get('/api/rooms', (req, res) => {
    const roomList = Array.from(rooms.keys()).map(room => ({
        name: room,
        userCount: rooms.get(room).size,
        messageCount: messageHistory.get(room)?.length || 0
    }));
    res.json(roomList);
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Express error:', err);
    res.status(500).json({
        error: 'Internal server error',
        timestamp: new Date().toISOString()
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Not found',
        path: req.path,
        timestamp: new Date().toISOString()
    });
});

// Environment configuration
const PORT = process.env.PORT || 80;
const HOST = '0.0.0.0'; // BIND TO ALL INTERFACES FOR EXTERNAL ACCESS

// Start server with external binding
server.listen(PORT, HOST, () => {
    console.log(`🚀 Server running on http://${HOST}:${PORT}`);
    console.log(`🌍 External access: Available on all network interfaces`);
    console.log(`📊 Stats available at http://${HOST}:${PORT}/api/stats`);
    console.log(`🏥 Health check at http://${HOST}:${PORT}/health`);
    console.log(`📅 Started at ${new Date().toISOString()}`);
    console.log(`✅ Ready for external connections from browsers`);
});

// Graceful shutdown
const gracefulShutdown = () => {
    console.log('\n🛑 Shutting down server gracefully...');

    // Notify all connected users
    io.emit('server_shutdown', {
        message: 'Server is shutting down. Please refresh to reconnect.'
    });

    server.close(() => {
        console.log('✅ HTTP server closed');

        // Close all socket connections
        io.close(() => {
            console.log('✅ Socket.IO server closed');
            console.log('👋 Goodbye!');
            process.exit(0);
        });
    });

    // Force close after timeout
    setTimeout(() => {
        console.error('❌ Could not close connections in time, forcefully shutting down');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
    gracefulShutdown();
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    gracefulShutdown();
});

// Export for testing
module.exports = { app, server, io };