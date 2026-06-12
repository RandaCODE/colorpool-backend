const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const dns = require('dns');
const axios = require('axios');
const crypto = require('crypto');
const admin = require('firebase-admin');
const http = require('http');
const rateLimit = require('express-rate-limit');
const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const { createClient } = require("redis");
const Joi = require('joi');
const { User, Bet, Transaction, GlobalState, Round, WebhookEvent } = require("./models");

// Force stable DNS for MongoDB Atlas
dns.setServers(['8.8.8.8', '8.8.4.4']);

// CONFIG
const PORT = process.env.PORT || 3000;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const MONGO_URI = process.env.MONGO_URI;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const INSTANCE_ID = crypto.randomBytes(8).toString('hex');

// External APIs
const paystackAxios = axios.create({
    baseURL: 'https://api.paystack.co',
    timeout: 30000,
});

// =======================
// LEADER ELECTION STATE
// =======================
let isMaster = false;

// =======================
// REDIS SETUP
// =======================
const pubClient = createClient({ url: REDIS_URL });
const subClient = pubClient.duplicate();
const stateSubClient = pubClient.duplicate(); // Separate client for state syncing

async function electLeader() {
    const lockKey = 'game_master_lock';
    const ttl = 5000; // 5 seconds lease
    try {
        // Attempt to acquire lock
        const result = await pubClient.set(lockKey, INSTANCE_ID, {
            PX: ttl,
            NX: true
        });

        if (result === 'OK') {
            if (!isMaster) console.log(`👑 [${INSTANCE_ID}] Elected as GAME MASTER`);
            isMaster = true;
        } else {
            // Check if we already hold the lock to extend the lease
            const currentLockOwner = await pubClient.get(lockKey);
            if (currentLockOwner === INSTANCE_ID) {
                await pubClient.pExpire(lockKey, ttl);
                isMaster = true;
            } else {
                if (isMaster) console.log(`🛰 [${INSTANCE_ID}] Stepping down to REPLICA (New Master: ${currentLockOwner})`);
                isMaster = false;
            }
        }
    } catch (e) {
        console.error("❌ Leader Election Error:", e.message);
        isMaster = false;
    }
}

async function initRedis() {
    try {
        await Promise.all([
            pubClient.connect(),
            subClient.connect(),
            stateSubClient.connect()
        ]);
        console.log(`✅ Redis Connected (Instance: ${INSTANCE_ID})`);

        // Listen for state updates from whoever is currently Master
        await stateSubClient.subscribe('game_state_updates', (message) => {
            if (!isMaster) {
                game = JSON.parse(message);
            }
        });

        // Start Election Cycle (every 2 seconds)
        setInterval(electLeader, 2000);
        await electLeader(); // Initial election
    } catch (e) {
        console.error("❌ Redis Connection Error:", e.message);
    }
}
initRedis();

// =======================
// FIREBASE ADMIN SETUP
// =======================
let firebaseConfigured = false;
try {
    const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
        ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
        : require("./serviceAccountKey.json");
    if (admin.apps.length === 0) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    console.log("✅ Firebase Admin Initialized");
    firebaseConfigured = true;
} catch (error) {
    console.error("❌ Firebase Init Error:", error.message);
}

const app = express();
const server = http.createServer(app);

// Trust proxy for rate limiting
app.set('trust proxy', 1);

const io = new Server(server, {
    cors: { origin: "*" },
    pingTimeout: 60000,
    pingInterval: 25000,
    adapter: createAdapter(pubClient, subClient)
});

// =======================
// JOI VALIDATION SCHEMAS
// =======================
const schemas = {
    bet: Joi.object({
        color: Joi.string().valid('green', 'purple', 'blue').required(),
        amount: Joi.number().min(100).max(1000000).required() // Max 1M Naira bet
    }),
    withdraw: Joi.object({
        amount: Joi.number().min(2000).max(500000).required(),
        bankName: Joi.string().required(),
        accountNumber: Joi.string().pattern(/^\d+$/).min(10).max(10).required(),
        bankCode: Joi.string().required(),
        accountName: Joi.string().required()
    }),
    deposit: Joi.object({
        email: Joi.string().email().required(),
        amount: Joi.number().min(100).max(500000).required()
    }),
    adminAction: Joi.object({
        transactionId: Joi.string().required(),
        action: Joi.string().valid('approve', 'reject').required(),
        notes: Joi.string().allow('').max(500)
    })
};

const validate = (schema) => (req, res, next) => {
    const { error } = schema.validate(req.body);
    if (error) return res.status(400).json({ success: false, error: error.details[0].message });
    next();
};

// =======================
// SOCKET.IO AUTHENTICATION
// =======================
io.use(async (socket, next) => {
    try {
        const token = socket.handshake.auth.token;
        if (!token) return next(new Error("Authentication required"));
        if (!firebaseConfigured) return next(new Error("Auth service unavailable"));
        const decodedToken = await admin.auth().verifyIdToken(token);
        socket.userId = decodedToken.uid;
        next();
    } catch (error) {
        next(new Error("Unauthorized"));
    }
});

io.on("connection", async (socket) => {
    socket.join(socket.userId);
    const response = await getGameResponse();
    socket.emit("game_update", response);
});

// =======================
// RATE LIMITERS
// =======================
const globalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
const financialLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

app.use(cors());
app.use(globalLimiter);
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// =======================
// DATABASE CONNECTION
// =======================
if (MONGO_URI) {
    mongoose.connect(MONGO_URI).then(() => {
        console.log("✅ MongoDB Connected");
        startGameLoop();
    }).catch(err => console.error("❌ MongoDB Error:", err.message));
}

// =======================
// AUTH MIDDLEWARE
// =======================
async function verifyToken(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ success: false, error: 'Unauthorized' });
        const decodedToken = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
        req.user = decodedToken;
        next();
    } catch (error) {
        return res.status(401).json({ success: false, error: 'Invalid session' });
    }
}

async function verifyAdmin(req, res, next) {
    const user = await User.findOne({ userId: req.user.uid });
    if (user?.isAdmin) return next();
    res.status(403).json({ success: false, error: "Forbidden" });
}

// =======================
// GAME ENGINE (REDIS POWERED)
// =======================
const PROBABILITIES = { green: 0.485, purple: 0.323, blue: 0.192 };
const multipliers = { green: 2, purple: 3, blue: 5 };
const ROUND_TIME = 30;
const LOCK_AT = 10;
const RESULT_AT = 5;

async function getRedisPools(roundId) {
    const data = await pubClient.hGetAll(`pools:${roundId}`);
    return {
        green: parseInt(data.green || 0),
        purple: parseInt(data.purple || 0),
        blue: parseInt(data.blue || 0)
    };
}

let game = {
    roundId: `R-${Date.now()}`,
    time: ROUND_TIME,
    status: "betting",
    bettingLocked: false,
    winner: null,
    serverSeed: null,
    serverSeedHash: null,
    clientSeed: `CLIENT_${Date.now()}`
};

function getSanitizedGame() {
    const { serverSeed, ...sanitized } = game;
    return sanitized;
}

async function getGameResponse() {
    const pools = await getRedisPools(game.roundId);
    return { ...getSanitizedGame(), pools };
}

async function broadcastGameState() {
    if (!isMaster) return;
    // Master publishes to Redis for non-master instances to sync their local state
    await pubClient.publish('game_state_updates', JSON.stringify(game));
    // Broadcast via Socket.io adapter to all connected clients
    const response = await getGameResponse();
    io.emit("game_update", response);
}

function determineWinner(serverSeed, clientSeed, roundId) {
    const combined = `${serverSeed}:${clientSeed}:${roundId}`;
    const hash = crypto.createHash('sha256').update(combined).digest('hex');
    const num = parseInt(hash.substring(0, 8), 16) / 0xffffffff;
    if (num < PROBABILITIES.green) return "green";
    if (num < (PROBABILITIES.green + PROBABILITIES.purple)) return "purple";
    return "blue";
}

async function finalizeRound() {
    const pools = await getRedisPools(game.roundId);
    const { roundId, winner, serverSeed, serverSeedHash, clientSeed } = game;
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            if (await Round.findOne({ roundId }).session(session)) return;

            await Round.create([{ roundId, winner, serverSeed, serverSeedHash, clientSeed, pools }], { session });

            const bets = await Bet.find({ roundId, settled: false }).session(session);
            if (bets.length === 0) return;

            const userUpdates = [];
            const betUpdates = [];
            const winTransactions = [];
            const updateTransactions = [];

            for (const bet of bets) {
                const isWinner = bet.color.toLowerCase() === winner.toLowerCase();

                betUpdates.push({
                    updateOne: { filter: { _id: bet._id }, update: { $set: { settled: true } } }
                });

                const payout = isWinner ? bet.amount * multipliers[winner] : 0;

                if (isWinner) {
                    userUpdates.push({
                        updateOne: {
                            filter: { userId: bet.userId },
                            update: { $inc: { balance: payout, "stats.totalWins": 1 } }
                        }
                    });

                    winTransactions.push({
                        userId: bet.userId, type: 'win', amount: payout, description: `Win on ${winner.toUpperCase()}`,
                        status: 'success', roundId, winningColor: winner, userColor: bet.color
                    });
                }

                if (bet.transactionId) {
                    updateTransactions.push({
                        updateOne: {
                            filter: { _id: bet.transactionId },
                            update: { $set: { status: 'success', winningColor: winner, payout: payout } }
                        }
                    });
                }
            }

            // Perform Bulk Operations for High Performance
            if (userUpdates.length > 0) await User.bulkWrite(userUpdates, { session });
            if (betUpdates.length > 0) await Bet.bulkWrite(betUpdates, { session });
            if (updateTransactions.length > 0) await Transaction.bulkWrite(updateTransactions, { session });
            if (winTransactions.length > 0) await Transaction.insertMany(winTransactions, { session });
        });

        io.emit("transaction_update");
    } catch (e) {
        console.error("❌ Settlement Error:", e.message);
    } finally {
        session.endSession();
    }
}

function startGameLoop() {
    setInterval(async () => {
        if (!isMaster) return;

        if (!game.serverSeed) {
            game.serverSeed = crypto.randomBytes(32).toString('hex');
            game.serverSeedHash = crypto.createHash('sha256').update(game.serverSeed).digest('hex');
        }

        game.time--;

        if (game.time === ROUND_TIME - 1) io.emit("round_hash", { hash: game.serverSeedHash });

        if (game.time === LOCK_AT) {
            game.bettingLocked = true;
            game.status = "locked";
            game.winner = determineWinner(game.serverSeed, game.clientSeed, game.roundId);
        }

        if (game.time === RESULT_AT) {
            game.status = "result";
            io.emit("round_result", { winner: game.winner });
            finalizeRound();
        }

        if (game.time <= 0) {
            const nextSeed = crypto.randomBytes(32).toString('hex');
            game = {
                roundId: `R-${Date.now()}`,
                time: ROUND_TIME, status: "betting", bettingLocked: false,
                winner: null, serverSeed: nextSeed, serverSeedHash: crypto.createHash('sha256').update(nextSeed).digest('hex'),
                clientSeed: `CLIENT_${Date.now()}`
            };
            io.emit("round_reset", { roundId: game.roundId });
        }

        broadcastGameState();
    }, 1000);
}

// =======================
// ROUTES
// =======================

app.get('/game-state', verifyToken, async (req, res) => {
    const user = await User.findOne({ userId: req.user.uid }) || await User.create({ userId: req.user.uid, balance: 100000 });
    const history = await Round.find().sort({ createdAt: -1 }).limit(20);
    const response = await getGameResponse();
    res.json({
        success: true,
        data: { ...response, balance: user.balance / 100, colorHistory: history.map(r => r.winner) }
    });
});

app.post('/bet', verifyToken, financialLimiter, validate(schemas.bet), async (req, res) => {
    const { color, amount } = req.body;
    const kobo = Math.floor(amount * 100);

    if (game.status !== "betting" || game.bettingLocked) return res.status(400).json({ success: false, error: "Betting locked for this round." });

    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            const user = await User.findOneAndUpdate(
                { userId: req.user.uid, balance: { $gte: kobo } },
                { $inc: { balance: -kobo, "stats.totalBets": 1 } },
                { session, new: true }
            );
            if (!user) throw new Error("Insufficient funds");

            const tx = await Transaction.create([{
                userId: req.user.uid, type: 'bet', amount: -kobo, balanceAfter: user.balance,
                status: 'pending', roundId: game.roundId, userColor: color
            }], { session });

            await Bet.create([{
                userId: req.user.uid, roundId: game.roundId, color, amount: kobo, transactionId: tx[0]._id
            }], { session });

            await pubClient.hIncrBy(`pools:${game.roundId}`, color, kobo);
        });

        const pools = await getRedisPools(game.roundId);
        io.emit("pool_update", pools);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    } finally {
        session.endSession();
    }
});

app.post('/initialize-payment', verifyToken, financialLimiter, validate(schemas.deposit), async (req, res) => {
    try {
        const response = await paystackAxios.post('/transaction/initialize', {
            email: req.body.email, amount: Math.floor(req.body.amount * 100),
            metadata: { userId: req.user.uid }
        }, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } });
        res.json({ success: true, data: response.data.data });
    } catch (e) {
        res.status(500).json({ success: false, error: "Gateway error" });
    }
});

app.post('/withdraw', verifyToken, financialLimiter, validate(schemas.withdraw), async (req, res) => {
    const kobo = Math.floor(req.body.amount * 100);
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            const pending = await Transaction.findOne({ userId: req.user.uid, type: 'withdrawal', status: 'pending' }).session(session);
            if (pending) throw new Error("You already have a pending withdrawal request.");

            const user = await User.findOneAndUpdate({ userId: req.user.uid, balance: { $gte: kobo } }, { $inc: { balance: -kobo } }, { session, new: true });
            if (!user) throw new Error("Insufficient funds");

            await Transaction.create([{
                userId: req.user.uid, type: 'withdrawal', amount: -kobo, balanceAfter: user.balance,
                status: 'pending', bankDetails: req.body
            }], { session });
        });
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    } finally {
        session.endSession();
    }
});

app.post('/claim-bonus', verifyToken, financialLimiter, async (req, res) => {
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            const oneDayAgo = new Date(Date.now() - 86400000);
            const user = await User.findOneAndUpdate(
                { userId: req.user.uid, $or: [{ lastBonusClaimTime: { $lt: oneDayAgo } }, { lastBonusClaimTime: null }] },
                { $inc: { balance: 10000 }, $set: { lastBonusClaimTime: new Date() } },
                { session, new: true }
            );
            if (!user) throw new Error("Bonus already claimed in the last 24 hours.");
            await Transaction.create([{ userId: req.user.uid, type: 'bonus', amount: 10000, balanceAfter: user.balance }], { session });
        });
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    } finally {
        session.endSession();
    }
});

app.post('/admin/withdraw/action', verifyToken, verifyAdmin, validate(schemas.adminAction), async (req, res) => {
    const { transactionId, action, notes } = req.body;
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            const tx = await Transaction.findById(transactionId).session(session);
            if (!tx || tx.status !== 'pending') throw new Error("Invalid transaction.");

            tx.status = action === 'approve' ? 'success' : 'rejected';
            tx.adminNotes = notes;
            tx.processedBy = req.user.uid;
            await tx.save({ session });

            if (action === 'reject') {
                const user = await User.findOneAndUpdate({ userId: tx.userId }, { $inc: { balance: Math.abs(tx.amount) } }, { session, new: true });
                await Transaction.create([{ userId: tx.userId, type: 'refund', amount: Math.abs(tx.amount), balanceAfter: user.balance, description: "Withdrawal refund" }], { session });
            }
        });
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    } finally {
        session.endSession();
    }
});

server.listen(PORT, () => console.log(`🚀 Production-Hardened Server on port ${PORT}`));
