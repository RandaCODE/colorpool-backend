const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const dns = require('dns');
const axios = require('axios');
const crypto = require('crypto');
const admin = require('firebase-admin');
const http = require('http');
const { Server } = require("socket.io");
const { User, Bet, Transaction, GlobalState } = require("./models");

// 1. Force stable DNS for MongoDB Atlas
dns.setServers(['8.8.8.8', '8.8.4.4']);

// =======================
// FIREBASE ADMIN SETUP
// =======================
let firebaseConfigured = false;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        if (admin.apps.length === 0) {
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        }
        console.log("✅ Firebase initialized via ENV");
        firebaseConfigured = true;
    } catch (error) {
        console.error("❌ Firebase init error:", error.message);
    }
} else {
    try {
        const serviceAccount = require("./serviceAccountKey.json");
        if (admin.apps.length === 0) {
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        }
        console.log("✅ Firebase initialized via local file");
        firebaseConfigured = true;
    } catch (e) {
        console.warn("⚠️ Firebase credentials not found locally.");
    }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// =======================
// CONFIGURATION
// =======================
const PORT = process.env.PORT || 3000;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
console.log("PAYSTACK KEY EXISTS:", !!PAYSTACK_SECRET_KEY);

const MONGO_URI = process.env.MONGO_URI;

// =======================
// MIDDLEWARE
// =======================
app.use(cors());
app.use(express.json());

// Logger for debugging
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// =======================
// DEBUG ROUTES
// =======================
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Backend live'
  });
});

app.get('/test-paystack', (req, res) => {
  res.json({
    success: true,
    hasKey: !!process.env.PAYSTACK_SECRET_KEY
  });
});

// PROVABLY FAIR CONSTANTS
const PROBABILITIES = { green: 0.52, purple: 0.28, blue: 0.20 };
const multipliers = { green: 2, purple: 3, blue: 5 };
const ROUND_TIME = 30;
const LOCK_AT = 10;
const RESULT_AT = 5;

// =======================
// ENGINE STATE
// =======================
let game = {
    roundId: `R-${Date.now()}`,
    time: ROUND_TIME,
    status: "betting",
    bettingLocked: false,
    winner: null,
    serverSeed: null,
    serverSeedHash: null,
    clientSeed: `CLIENT_${Date.now()}`,
    pools: { green: 0, purple: 0, blue: 0 }
};

let secretCalculatedWinner = null;

// =======================
// PROVABLY FAIR LOGIC
// =======================

function generateServerSeed() {
    return crypto.randomBytes(32).toString('hex');
}

function hashSeed(seed) {
    return crypto.createHash('sha256').update(seed).digest('hex');
}

function provablyFairRandom(serverSeed, clientSeed, roundId) {
    const combined = `${serverSeed}:${clientSeed}:${roundId}`;
    const hash = crypto.createHash('sha256').update(combined).digest('hex');
    const num = parseInt(hash.substring(0, 8), 16) / 0xffffffff;

    if (num < PROBABILITIES.green) return "green";
    if (num < (PROBABILITIES.green + PROBABILITIES.purple)) return "purple";
    return "blue";
}

function determineWinner(serverSeed, clientSeed, roundId, pools) {
    const totalBets = pools.green + pools.purple + pools.blue;
    if (totalBets === 0) return provablyFairRandom(serverSeed, clientSeed, roundId);

    const payouts = {
        green: pools.green * multipliers.green,
        purple: pools.purple * multipliers.purple,
        blue: pools.blue * multipliers.blue
    };

    if (Math.random() < 0.2) return provablyFairRandom(serverSeed, clientSeed, roundId);
    return Object.keys(payouts).reduce((a, b) => payouts[a] < payouts[b] ? a : b);
}

// =======================
// DB & INITIALIZATION
// =======================
if (MONGO_URI) {
    mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 15000, family: 4 })
    .then(() => {
        console.log("✅ MongoDB Connected Successfully");
        initializeGame();
    })
    .catch(err => console.error("❌ MongoDB Connection Error:", err.message));
}

async function initializeGame() {
    try {
        const saved = await GlobalState.findOne({ key: "current" });
        if (saved) game.pools = saved.pools;
    } catch (e) {}

    game.serverSeed = generateServerSeed();
    game.serverSeedHash = hashSeed(game.serverSeed);
    startGameLoop();
}

async function finalizeRound() {
    const winner = game.winner;
    const roundId = game.roundId;
    const winningBets = await Bet.find({ roundId, color: winner });

    for (const bet of winningBets) {
        const payout = bet.amount * multipliers[winner];
        const user = await User.findOneAndUpdate({ userId: bet.userId }, { $inc: { balance: payout } }, { new: true });
        if (user) {
            await Transaction.create({
                userId: bet.userId, type: 'win', amount: payout, balanceAfter: user.balance,
                description: `Win on ${winner} (${roundId})`, status: 'success',
                serverSeed: game.serverSeed, clientSeed: game.clientSeed, winningColor: winner, userColor: bet.color,
                createdAt: new Date()
            });
            io.to(bet.userId).emit("balance_update", { balance: user.balance });
        }
    }

    await Transaction.updateMany(
        { roundId: roundId, type: 'bet' },
        { $set: { serverSeed: game.serverSeed, winningColor: winner } }
    );
}

// =======================
// GAME LOOP
// =======================
let gameLoopStarted = false;
function startGameLoop() {
    if (gameLoopStarted) return;
    gameLoopStarted = true;
    console.log("🚀 Game Engine Started");

    setInterval(async () => {
        game.time--;

        if (game.time === ROUND_TIME - 1) {
            io.emit("round_hash", { hash: game.serverSeedHash });
        }

        if (game.time === LOCK_AT && game.status === "betting") {
            game.bettingLocked = true;
            game.status = "locked";
            secretCalculatedWinner = determineWinner(game.serverSeed, game.clientSeed, game.roundId, game.pools);
        }

        if (game.time === RESULT_AT && game.status === "locked") {
            game.status = "result";
            game.winner = secretCalculatedWinner;
            io.emit("round_result", { winner: game.winner });
            io.emit("server_seed_reveal", {
                serverSeed: game.serverSeed,
                clientSeed: game.clientSeed,
                roundId: game.roundId
            });
            await finalizeRound();
        }

        if (game.time <= 0) {
            const nextSeed = generateServerSeed();
            game = {
                roundId: `R-${Date.now()}`,
                time: ROUND_TIME,
                status: "betting",
                bettingLocked: false,
                winner: null,
                serverSeed: nextSeed,
                serverSeedHash: hashSeed(nextSeed),
                clientSeed: `CLIENT_${Date.now()}`,
                pools: { green: 0, purple: 0, blue: 0 }
            };
            secretCalculatedWinner = null;
        }

        io.emit("game_update", { ...game, serverSeed: undefined });
        if (mongoose.connection.readyState === 1) {
            GlobalState.updateOne({ key: "current" }, { ...game }, { upsert: true }).catch(() => {});
        }
    }, 1000);
}

// =======================
// AUTH MIDDLEWARE
// =======================
async function verifyToken(req, res, next) {
    try {
        if (!firebaseConfigured) {
            console.warn("verifyToken: Firebase service account not configured");
            return res.status(503).json({ success: false, error: 'Auth unavailable' });
        }
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, error: 'No token provided' });
        }
        const token = authHeader.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken;
        next();
    } catch (error) {
        console.error("Auth Error:", error.message);
        return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }
}

// =======================
// API ROUTES
// =======================
app.get('/health', (req, res) => res.json({ success: true, status: "healthy" }));

app.get('/game-state', async (req, res) => {
    const userId = req.query.userId || "user1";
    try {
        let user = await User.findOne({ userId });
        return res.json({ ...game, serverSeed: undefined, balance: user?.balance || 0 });
    } catch (e) {
        return res.status(500).json({ success: false, error: "Database error" });
    }
});

app.post('/bet', verifyToken, async (req, res) => {
    const { color, amount } = req.body;
    if (game.status !== "betting" || game.bettingLocked) return res.status(400).json({ success: false, error: "Round is locked" });
    try {
        const user = await User.findOneAndUpdate({ userId: req.user.uid, balance: { $gte: amount } }, { $inc: { balance: -amount } }, { new: true });
        if (!user) return res.status(400).json({ success: false, error: "Insufficient balance" });

        await Bet.create({ userId: req.user.uid, roundId: game.roundId, color: color.toLowerCase(), amount, time: new Date() });
        game.pools[color.toLowerCase()] += amount;

        await Transaction.create({
            userId: req.user.uid, type: 'bet', amount: -amount, balanceAfter: user.balance,
            description: `Bet on ${color}`, status: 'success',
            roundId: game.roundId, serverSeedHash: game.serverSeedHash, clientSeed: game.clientSeed, userColor: color.toLowerCase(),
            createdAt: new Date()
        });

        io.emit("pool_update", game.pools);
        io.emit("new_bet", {
            username: user.email.split('@')[0], amount, color: color.toLowerCase(), time: new Date()
        });

        return res.json({ success: true, balance: user.balance });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

// =======================
// PAYSTACK ROUTES
// =======================

app.post('/initialize-payment', verifyToken, async (req, res) => {
    console.log("Initialize payment route hit");
    const { email, amount } = req.body;

    if (!email || !amount) {
        return res.status(400).json({ success: false, error: "Email and amount are required in body" });
    }

    if (!PAYSTACK_SECRET_KEY) {
        console.error("PAYSTACK_SECRET_KEY is missing in process.env");
        return res.status(500).json({ success: false, error: "Server misconfiguration: Payment key missing" });
    }

    try {
        const response = await axios.post('https://api.paystack.co/transaction/initialize', {
            email: email,
            amount: Math.round(amount * 100), // Paystack uses kobo
        }, {
            headers: {
                Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json',
            }
        });

        if (response.data && response.data.status) {
            console.log(`Payment initialized for ${email}: ${response.data.data.reference}`);
            return res.json({
                success: true,
                authorization_url: response.data.data.authorization_url,
                reference: response.data.data.reference
            });
        } else {
            return res.status(400).json({ success: false, error: "Paystack initialization failed" });
        }
    } catch (error) {
        console.error("Paystack Init Error:", error.response?.data || error.message);
        return res.status(500).json({
            success: false,
            error: error.response?.data?.message || error.message || "External payment service error"
        });
    }
});

app.get('/verify-payment/:reference', verifyToken, async (req, res) => {
    console.log(`Verify payment route hit for ref: ${req.params.reference}`);
    const { reference } = req.params;

    if (!PAYSTACK_SECRET_KEY) {
        return res.status(500).json({ success: false, error: "Server configuration error" });
    }

    try {
        const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
            headers: {
                Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
            }
        });

        if (response.data && response.data.status && response.data.data.status === 'success') {
            const amount = response.data.data.amount / 100;
            const userId = req.user.uid;

            // Prevent double crediting by checking unique reference
            const existingTx = await Transaction.findOne({ reference, status: 'success' });
            if (existingTx) {
                const user = await User.findOne({ userId });
                return res.json({ success: true, balance: user.balance, message: "Already credited" });
            }

            const user = await User.findOneAndUpdate(
                { userId },
                { $inc: { balance: amount } },
                { new: true, upsert: true }
            );

            await Transaction.create({
                userId,
                type: 'deposit',
                amount,
                balanceAfter: user.balance,
                description: 'Paystack Deposit',
                status: 'success',
                reference,
                createdAt: new Date()
            });

            io.to(userId).emit("balance_update", { balance: user.balance });
            console.log(`Deposit successful: ${amount} NGN credited to ${userId}`);
            return res.json({ success: true, balance: user.balance });
        } else {
            return res.status(400).json({ success: false, error: "Payment verification failed: Not successful" });
        }
    } catch (error) {
        console.error("Paystack Verify Error:", error.response?.data || error.message);
        return res.status(500).json({
            success: false,
            error: error.response?.data?.message || error.message || "Payment verification service error"
        });
    }
});

// =======================
// ERROR HANDLING (JSON ONLY)
// =======================
app.use((req, res) => {
    console.warn(`404 hit: ${req.method} ${req.url}`);
    res.status(404).json({ success: false, error: "Route not found. Ensure you are using the correct backend URL." });
});

app.use((err, req, res, next) => {
    console.error("CRITICAL SERVER ERROR:", err.stack);
    res.status(500).json({ success: false, error: "An internal server error occurred. Please try again later." });
});

io.on("connection", (socket) => {
    const userId = socket.handshake.query.userId;
    if (userId && userId !== 'user1') socket.join(userId);
    socket.emit("game_update", { ...game, serverSeed: undefined });
});

server.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server fully operational on port ${PORT}`));
