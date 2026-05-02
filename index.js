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

// 1. Stable DNS fix
dns.setServers(['8.8.8.8', '8.8.4.4']);

// 2. Firebase Admin Setup
try {
    const serviceAccount = require("./serviceAccountKey.json");
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("🔥 Firebase Admin Ready");
} catch (e) {
    console.error("❌ Firebase Admin Error: serviceAccountKey.json missing.");
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(cors());
app.use(express.json());

// =======================
// CONFIGURATION
// =======================
const PORT = process.env.PORT || 3000;
const MONGO_URI = "mongodb+srv://randastevenzhu_db_user:wNe4BaZ29FRDrONT@cluster0.stacjum.mongodb.net/colorpool?retryWrites=true&w=majority";
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "sk_test_your_secret_key";

// GAME TIMING (SYNCED 30s CYCLE)
const ROUND_TIME = 30;
const LOCK_AT = 10;
const RESULT_AT = 5;
const multipliers = { green: 2, purple: 3, blue: 5 };

// STEP 1 — CREATE GAME STATE
let game = {
    time: ROUND_TIME,
    status: "betting", // betting | locked | result
    roundId: `R-${Date.now()}`,
    winner: null,
    pools: { green: 0, purple: 0, blue: 0 }
};

let secretCalculatedWinner = null;

// =======================
// DB CONNECTION
// =======================
mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 15000, family: 4 })
.then(() => {
    console.log("✅ MongoDB Connected");
    initializeGame();
})
.catch(err => console.error("❌ DB Connection Error:", err.message));

async function initializeGame() {
    try {
        const saved = await GlobalState.findOne({ key: "current" });
        if (saved) game.pools = saved.pools;
    } catch (e) {}
    startGameLoop();
}

// =======================
// ENGINE LOGIC
// =======================

function calculateWinner() {
    const { green, purple, blue } = game.pools;
    const totalPool = green + purple + blue;
    const options = [
        { color: "green", payout: green * multipliers.green },
        { color: "purple", payout: purple * multipliers.purple },
        { color: "blue", payout: blue * multipliers.blue }
    ];
    options.forEach(o => o.profit = totalPool - o.payout);
    let profitableOptions = options.filter(o => o.profit >= 0);

    let chosen;
    if (totalPool === 0) {
        chosen = ["green", "purple", "blue"][Math.floor(Math.random() * 3)];
    } else if (Math.random() < 0.15) {
        chosen = options[Math.floor(Math.random() * options.length)].color;
    } else if (profitableOptions.length > 0) {
        chosen = profitableOptions[Math.floor(Math.random() * profitableOptions.length)].color;
    } else {
        options.sort((a, b) => b.profit - a.profit);
        chosen = options[0].color;
    }
    secretCalculatedWinner = chosen;
}

// STEP 4 — RESULT PROCESSING
async function processRoundResults() {
    const winner = game.winner;
    const roundId = game.roundId;
    console.log(`💰 Processing Payouts for Round ${roundId}. Winner: ${winner.toUpperCase()}`);

    try {
        const winningBets = await Bet.find({ roundId, color: winner });
        for (const bet of winningBets) {
            const payout = bet.amount * multipliers[winner];
            const user = await User.findOneAndUpdate({ userId: bet.userId }, { $inc: { balance: payout } }, { new: true });
            if (user) {
                await Transaction.create({
                    userId: bet.userId, type: 'win', amount: payout, balanceAfter: user.balance,
                    description: `Win on ${winner} (${roundId})`, status: 'success', createdAt: new Date()
                });
                // Emit instant update to the winner
                io.to(bet.userId).emit("balance_update", { balance: user.balance });
            }
        }
    } catch (e) {
        console.error("❌ Payout Error:", e.message);
    }
}

// STEP 2 — GAME LOOP (SERVER SIDE)
function startGameLoop() {
    console.log("🚀 STANDALONE ENGINE STARTED.");
    setInterval(async () => {
        game.time--;

        // LOCK AT 10 SECONDS
        if (game.time === LOCK_AT) {
            game.status = "locked";
            game.bettingLocked = true;
            calculateWinner(); // Calculated but not revealed
            console.log("🔒 Betting Locked.");
        }

        // RESULT AT 5 SECONDS
        if (game.time === RESULT_AT) {
            game.status = "result";
            game.winner = secretCalculatedWinner;

            // STEP 5 — SOCKET EVENTS
            io.emit("round_result", { winner: game.winner });
            console.log(`🏆 Result revealed: ${game.winner}`);

            await processRoundResults();
        }

        // RESET AT 0
        if (game.time <= 0) {
            game = {
                time: ROUND_TIME,
                status: "betting",
                roundId: `R-${Date.now()}`,
                winner: null,
                bettingLocked: false,
                pools: { green: 0, purple: 0, blue: 0 }
            };
            secretCalculatedWinner = null;
            console.log("🔁 Starting NEW Round.");
        }

        // Emit update to ALL clients every second
        io.emit("game_update", {
            ...game,
            calculatedWinner: undefined // Ensure hidden field is never leaked
        });

        // Sync state to DB
        if (mongoose.connection.readyState === 1) {
            GlobalState.updateOne({ key: "current" }, { ...game }, { upsert: true }).catch(() => {});
        }
    }, 1000);
}

// =======================
// SOCKETS & AUTH
// =======================
async function verifyToken(req, res, next) {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.user = decoded;
        next();
    } catch (e) { res.status(401).json({ error: 'Invalid token' }); }
}

io.on("connection", (socket) => {
    const userId = socket.handshake.query.userId;
    if (userId && userId !== 'user1') {
        socket.join(userId);
        console.log(`👤 User joined: ${userId}`);
    }
    // Send current game state immediately
    socket.emit("game_update", game);
});

// =======================
// API ROUTES
// =======================

app.get('/game-state', async (req, res) => {
    const userId = req.query.userId || "guest";
    try {
        let user = await User.findOne({ userId });
        res.json({ ...game, balance: user?.balance || 0 });
    } catch (e) { res.status(500).json({ error: "DB Error" }); }
});

app.post('/me', verifyToken, async (req, res) => {
    try {
        let user = await User.findOne({ userId: req.user.uid });
        if (!user) user = await User.create({ userId: req.user.uid, email: req.user.email, balance: 1000 });
        res.json(user);
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// STEP 3 — BET VALIDATION
app.post('/bet', verifyToken, async (req, res) => {
    const { color, amount } = req.body;
    const userId = req.user.uid;

    if (game.status !== "betting" || game.bettingLocked) {
        return res.status(400).json({ error: "Betting closed" });
    }

    try {
        const user = await User.findOneAndUpdate({ userId, balance: { $gte: amount } }, { $inc: { balance: -amount } }, { new: true });
        if (!user) return res.status(400).json({ error: "Insufficient balance" });

        await Bet.create({ userId, roundId: game.roundId, color: color.toLowerCase(), amount, time: new Date() });
        game.pools[color.toLowerCase()] += amount;

        await Transaction.create({
            userId, type: 'bet', amount: -amount, balanceAfter: user.balance,
            description: `Bet on ${color}`, status: 'success', createdAt: new Date()
        });

        io.emit("pool_update", game.pools);
        res.json({ success: true, balance: user.balance });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/withdraw', verifyToken, async (req, res) => {
    const { amount, bankDetails } = req.body;
    try {
        const user = await User.findOneAndUpdate({ userId: req.user.uid, balance: { $gte: amount } }, { $inc: { balance: -amount } }, { new: true });
        if (!user) return res.status(400).json({ error: "Insufficient balance" });
        await Transaction.create({ userId: req.user.uid, type: 'withdraw', amount: -amount, balanceAfter: user.balance, status: 'pending', bankDetails, createdAt: new Date() });
        res.json({ success: true, balance: user.balance });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/claim-bonus', verifyToken, async (req, res) => {
    const userId = req.user.uid;
    const user = await User.findOne({ userId });
    const now = new Date();
    if (user.lastBonusClaimTime && (now - user.lastBonusClaimTime < 24*60*60*1000)) return res.status(400).json({ error: "Wait 24h" });
    const update = await User.findOneAndUpdate({ userId }, { $inc: { balance: 500, playStreak: 1 }, $set: { lastBonusClaimTime: now } }, { new: true });
    await Transaction.create({ userId, type: 'bonus', amount: 500, balanceAfter: update.balance, description: 'Daily Bonus', status: 'success', createdAt: new Date() });
    res.json({ success: true, balance: update.balance });
});

app.get('/transactions', verifyToken, async (req, res) => {
    try {
        const txs = await Transaction.find({ userId: req.user.uid }).sort({ createdAt: -1 }).limit(50);
        res.json(txs);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 STANDALONE ENGINE ON PORT ${PORT}`);
});
