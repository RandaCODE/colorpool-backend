const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const admin = require('firebase-admin');
const http = require('http');
const socketIo = require('socket.io');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Initialize Firebase Admin
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        if (admin.apps.length === 0) {
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log('Firebase Admin Initialized');
        }
    } catch (err) {
        console.error('Firebase Admin Initialization Error:', err.message);
    }
} else {
    console.warn('FIREBASE_SERVICE_ACCOUNT not found in environment variables. Firebase Admin not initialized.');
}

// Middleware
app.use(cors());
app.use(express.json());

// DB Config
const db = process.env.MONGO_URI || 'mongodb://localhost:27017/colorpool';

// Connect to MongoDB
mongoose
    .connect(db, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('MongoDB Connected...'))
    .catch(err => console.log(err));

// Make io accessible to routes
app.set('io', io);

// Use Routes
app.use('/admin/auth', require('./routes/adminAuth'));
app.use('/admin/dashboard', require('./routes/dashboard'));
app.use('/admin/risk', require('./routes/risk'));
app.use('/admin/withdrawals', require('./routes/withdrawals'));
app.use('/admin/users', require('./routes/users'));
app.use('/admin/rounds', require('./routes/rounds'));

const port = process.env.PORT || 5000;

server.listen(port, () => console.log(`Server started on port ${port}`));
