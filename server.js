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
        origin: process.env.CLIENT_URL || "*",
        methods: ["GET", "POST"]
    }
});

// Security and performance middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            connectSrc: ["'self'", "ws:", "wss:"]
        }
    }
}));
app.use(cors());
app.use(compression());
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Store connected users and rooms
const users = new Map();
const rooms = new Map();
const messageHistory = new Map(); // Store recent messages per room
const laravelSockets = new Set(); // Store Laravel socket connections

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

// Process messages from Laravel socket clients
function processLaravelMessage(socket, messageStr) {
    try {
        const message = JSON.parse(messageStr);

        console.log(`📨 Received from Laravel: ${message.type}`);

        switch (message.type) {
            case 'emit':
                handleLaravelEmit(message);
                break;

            case 'emit_to_room':
                handleLaravelRoomEmit(message);
                break;

            case 'room_created':
                handleLaravelRoomCreation(message);
                break;

            case 'presence_update':
                handleLaravelPresenceUpdate(message);
                break;

            case 'ping':
                // Respond to ping
                socket.emit('pong', {
                    type: 'pong',
                    timestamp: new Date().toISOString()
                });
                console.log('🏓 Responded to Laravel ping');
                break;

            case 'heartbeat':
                console.log('💓 Heartbeat from Laravel');
                break;

            case 'disconnect':
                console.log('🔌 Laravel client requested disconnect');
                break;

            default:
                console.log(`⚠️ Unknown message type from Laravel: ${message.type}`);
        }

    } catch (error) {
        console.error('❌ Error processing Laravel message:', error);
        console.error('Raw message:', messageStr);
    }
}

function handleLaravelEmit(message) {
    try {
        const { event, data } = message;

        console.log(`📡 Emitting ${event} from Laravel`);

        // Emit to all connected clients
        io.emit(event, data);

    } catch (error) {
        console.error('❌ Error handling Laravel emit:', error);
    }
}

function handleLaravelRoomEmit(message) {
    try {
        const { room, event, data } = message;

        console.log(`📢 Emitting ${event} to room ${room} from Laravel`);

        // Ensure room exists
        if (!rooms.has(room)) {
            rooms.set(room, new Set());
            console.log(`📝 Created room tracking for: ${room}`);
        }

        // Emit to specific room
        io.to(room).emit(event, data);

        // Add to message history if it's a message
        if (event === 'receive_message') {
            addToMessageHistory(room, data);
            console.log(`💾 Added message to history for room: ${room}`);
        }

    } catch (error) {
        console.error('❌ Error handling Laravel room emit:', error);
    }
}

function handleLaravelRoomCreation(message) {
    try {
        const { room, new_user } = message;

        console.log(`🏠 Room created from Laravel: ${room.name} (${room.slug})`);

        // Create room tracking if needed
        if (!rooms.has(room.slug)) {
            rooms.set(room.slug, new Set());
            console.log(`📝 Created room tracking for: ${room.slug}`);
        }

        // Broadcast room creation
        if (room.type === 'collaboration') {
            io.emit('collaboration_room_created', {
                room: {
                    id: room.id,
                    slug: room.slug,
                    name: room.name,
                    type: room.type,
                    collaboration_id: room.collaboration_id
                },
                new_user: {
                    id: new_user.id,
                    name: new_user.name
                },
                timestamp: new Date().toISOString(),
                source: 'laravel'
            });
            console.log(`📢 Broadcasted collaboration room creation: ${room.name}`);
        } else if (room.type === 'direct') {
            console.log(`💬 Direct room created: ${room.name}`);
        }

    } catch (error) {
        console.error('❌ Error handling Laravel room creation:', error);
    }
}

function handleLaravelPresenceUpdate(message) {
    try {
        const { user_id, status, room } = message;

        console.log(`👤 User ${user_id} presence from Laravel: ${status}`);

        const presenceData = {
            user_id,
            status,
            timestamp: new Date().toISOString(),
            source: 'laravel'
        };

        if (room) {
            io.to(room).emit('user_presence_changed', { ...presenceData, room });
            console.log(`📢 Broadcasted presence to room: ${room}`);
        } else {
            io.emit('user_presence_changed', presenceData);
            console.log(`📢 Broadcasted presence globally`);
        }

    } catch (error) {
        console.error('❌ Error handling Laravel presence update:', error);
    }
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id} at ${new Date().toISOString()}`);

    // Track Laravel client connections
    let isLaravelClient = false;
    let dataBuffer = '';

    // Handle raw data for Laravel socket clients
    socket.conn.on('data', (data) => {
        try {
            const message = data.toString().trim();

            // Check for Laravel client identification
            if (message === 'LARAVEL_CLIENT') {
                isLaravelClient = true;
                socket.isLaravelClient = true;
                laravelSockets.add(socket.id);
                console.log('🔗 Laravel socket client connected via raw socket');

                // Send acknowledgment
                socket.emit('laravel_connected', {
                    message: 'Laravel client connected successfully',
                    server_time: new Date().toISOString()
                });
                return;
            }

            // If it's a Laravel client, process the JSON data
            if (isLaravelClient || socket.isLaravelClient) {
                dataBuffer += message;

                // Process complete JSON messages (separated by newlines)
                const messages = dataBuffer.split('\n');
                dataBuffer = messages.pop() || ''; // Keep incomplete message

                messages.forEach(msg => {
                    if (msg.trim()) {
                        processLaravelMessage(socket, msg);
                    }
                });
                return;
            }

        } catch (error) {
            console.error('❌ Error processing raw socket data:', error);
        }
    });

    // Regular Socket.IO event handlers for browser clients
    socket.on('join', (userData) => {
        // Skip if this is a Laravel client
        if (socket.isLaravelClient) return;

        try {
            const { username, room = 'general', userId = null } = userData;

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

            // Store user data with Laravel user ID if provided
            users.set(socket.id, {
                username,
                room,
                socketId: socket.id,
                userId: userId, // Laravel user ID for integration
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
        // Skip if this is a Laravel client
        if (socket.isLaravelClient) return;

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
                userId: user.userId,
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
        // Skip if this is a Laravel client
        if (socket.isLaravelClient) return;

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
        // Skip if this is a Laravel client
        if (socket.isLaravelClient) return;

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
        // Skip if this is a Laravel client
        if (socket.isLaravelClient) return;

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
        // Skip if this is a Laravel client
        if (socket.isLaravelClient) return;

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
        // Skip if this is a Laravel client
        if (socket.isLaravelClient) return;

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
        // Skip if this is a Laravel client
        if (socket.isLaravelClient) return;

        try {
            const roomUsers = Array.from(rooms.get(room) || [])
                .map(id => users.get(id)).filter(u => u);
            socket.emit('room_users', { room, users: roomUsers });
        } catch (error) {
            console.error('Error in get_room_users handler:', error);
        }
    });

    // Handle Laravel client events through regular Socket.IO
    socket.on('laravel_emit', (data) => {
        if (!socket.isLaravelClient) return;

        try {
            const { event, payload } = data;
            console.log(`📡 Laravel emit via Socket.IO: ${event}`);
            io.emit(event, payload);
        } catch (error) {
            console.error('❌ Error handling Laravel emit:', error);
        }
    });

    socket.on('laravel_emit_to_room', (data) => {
        if (!socket.isLaravelClient) return;

        try {
            const { room, event, payload } = data;
            console.log(`📢 Laravel emit to room ${room}: ${event}`);

            if (!rooms.has(room)) {
                rooms.set(room, new Set());
            }

            io.to(room).emit(event, payload);

            if (event === 'receive_message') {
                addToMessageHistory(room, payload);
            }
        } catch (error) {
            console.error('❌ Error handling Laravel room emit:', error);
        }
    });

    socket.on('laravel_room_created', (data) => {
        if (!socket.isLaravelClient) return;

        handleLaravelRoomCreation(data);
    });

    socket.on('laravel_presence_update', (data) => {
        if (!socket.isLaravelClient) return;

        handleLaravelPresenceUpdate(data);
    });

    socket.on('disconnect', (reason) => {
        try {
            if (socket.isLaravelClient) {
                laravelSockets.delete(socket.id);
                console.log('🔌 Laravel socket client disconnected');
                return;
            }

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
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        connectedClients: io.engine.clientsCount,
        laravelSockets: laravelSockets.size,
        regularUsers: users.size,
        activeRooms: rooms.size
    });
});

// API endpoints
app.get('/api/stats', (req, res) => {
    const stats = {
        connectedUsers: users.size,
        activeRooms: rooms.size,
        laravelSockets: laravelSockets.size,
        totalConnections: io.engine.clientsCount,
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

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || 'localhost';

server.listen(PORT, () => {
    console.log(`🚀 Server running on http://${HOST}:${PORT}`);
    console.log(`📊 Stats available at http://${HOST}:${PORT}/api/stats`);
    console.log(`🏥 Health check at http://${HOST}:${PORT}/health`);
    console.log(`📅 Started at ${new Date().toISOString()}`);
    console.log(`🔗 Ready to accept Laravel socket connections`);
    console.log(`💡 Laravel clients should send 'LARAVEL_CLIENT' to identify`);
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