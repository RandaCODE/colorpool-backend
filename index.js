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
const stateSubClient = pubClient.duplicate();

async function electLeader() {
    const lockKey = 'game_master_lock';
    const ttl = 5000;
    try {
        const result = await pubClient.set(lockKey, INSTANCE_ID, { PX: ttl, NX: true });
        if (result === 'OK') {
            if (!isMaster) console.log(`👑 [${INSTANCE_ID}] Elected as GAME MASTER`);
            isMaster = true;
        } else {
            const currentLockOwner = await pubClient.get(lockKey);
            if (currentLockOwner === INSTANCE_ID) {
                await pubClient.pExpire(lockKey, ttl);
                isMaster = true;
            } else {
                if (isMaster) console.log(`🛰 [${INSTANCE_ID}] Stepping down to REPLICA (New Master: ${currentLockOwner})`);
                isMaster = false;
            }
        }
    } catch (e) { isMaster = false; }
}

async function initRedis() {
    try {
        await Promise.all([pubClient.connect(), subClient.connect(), stateSubClient.connect()]);
        console.log(`✅ Redis Connected`);
        await stateSubClient.subscribe('game_state_updates', (message) => {
            if (!isMaster) {
                const updatedGame = JSON.parse(message);
                if (game.roundId !== updatedGame.roundId || Math.abs(game.time - updatedGame.time) > 1) {
                    game = updatedGame;
                } else {
                    game.time = updatedGame.time;
                    game.status = updatedGame.status;
                    game.bettingLocked = updatedGame.bettingLocked;
                    game.winner = updatedGame.winner;
                }
            }
        });
        setInterval(electLeader, 2000);
        await electLeader();
    } catch (e) { console.error("❌ Redis Error:", e.message); }
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
    firebaseConfigured = true;
} catch (error) { console.error("❌ Firebase Init Error:", error.message); }

const app = express();
const server = http.createServer(app);
app.set('trust proxy', 1);

const io = new Server(server, {
    cors: { origin: "*" },
    pingTimeout: 60000,
    adapter: createAdapter(pubClient, subClient)
});

// =======================
// JOI VALIDATION
// =======================
const schemas = {
    bet: Joi.object({
        color: Joi.string().valid('green', 'purple', 'blue').required(),
        amount: Joi.number().min(100).max(1000000).required()
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
// SOCKET AUTH
// =======================
io.use(async (socket, next) => {
    try {
        const token = socket.handshake.auth.token || socket.handshake.query.token;
        if (!token) {
            if (socket.handshake.query.userId) { socket.userId = socket.handshake.query.userId; return next(); }
            return next();
        }
        const decodedToken = await admin.auth().verifyIdToken(token);
        socket.userId = decodedToken.uid;
        next();
    } catch (error) {
        if (socket.handshake.query.userId) { socket.userId = socket.handshake.query.userId; return next(); }
        next();
    }
});

io.on("connection", async (socket) => {
    if (socket.userId) socket.join(socket.userId);
    const response = await getGameResponse();
    socket.emit("game_update", response);
});

// =======================
// MIDDLEWARE
// =======================
app.use(cors());
app.use(express.json());

async function verifyToken(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ success: false, error: 'Unauthorized' });
        const decodedToken = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
        req.user = decodedToken;
        next();
    } catch (error) { return res.status(401).json({ success: false, error: 'Invalid session' }); }
}

// =======================
// GAME ENGINE
// =======================
const multipliers = { green: 2, purple: 3, blue: 5 };
const ROUND_TIME = 30;
const LOCK_AT = 10;
const RESULT_AT = 5;

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

async function getRedisPools(roundId) {
    const data = await pubClient.hGetAll(`pools:${roundId}`);
    return {
        green: (parseInt(data.green || 0) / 100),
        purple: (parseInt(data.purple || 0) / 100),
        blue: (parseInt(data.blue || 0) / 100)
    };
}

async function getGameResponse() {
    const pools = await getRedisPools(game.roundId);
    const { serverSeed, ...sanitized } = game;
    return { ...sanitized, pools };
}

async function finalizeRound() {
    const roundId = game.roundId;
    const winner = game.winner;
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            if (await Round.findOne({ roundId }).session(session)) return;
            const pools = await getRedisPools(roundId);
            await Round.create([{ ...game, pools }], { session });

            const bets = await Bet.find({ roundId, settled: false }).session(session);
            for (const bet of bets) {
                const isWinner = bet.color.toLowerCase() === winner.toLowerCase();
                const payoutKobo = isWinner ? bet.amount * multipliers[winner] : 0;

                await Bet.updateOne({ _id: bet._id }, { $set: { settled: true, result: isWinner ? "WON" : "LOST", payout: payoutKobo } }).session(session);

                if (isWinner) {
                    const user = await User.findOneAndUpdate({ userId: bet.userId }, { $inc: { balance: payoutKobo, "stats.totalWins": 1 } }, { session, new: true });
                    await Transaction.create([{
                        userId: bet.userId, type: 'win', amount: payoutKobo, status: 'success', roundId, winningColor: winner, userColor: bet.color, balanceAfter: user.balance
                    }], { session });
                    io.to(bet.userId).emit("balance_update", { balance: user.balance / 100 });
                }
                if (bet.transactionId) {
                    await Transaction.updateOne({ _id: bet.transactionId }, { $set: { status: 'success', winningColor: winner, payout: payoutKobo } }).session(session);
                }
            }
        });
        io.emit("transaction_update");
    } catch (e) { console.error("❌ Finalize Error:", e.message); } finally { session.endSession(); }
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
            const combined = `${game.serverSeed}:${game.clientSeed}:${game.roundId}`;
            const hash = crypto.createHash('sha256').update(combined).digest('hex');
            const num = parseInt(hash.substring(0, 8), 16) / 0xffffffff;
            game.winner = num < 0.485 ? "green" : (num < 0.808 ? "purple" : "blue");
        }
        if (game.time === RESULT_AT) {
            game.status = "result";
            io.emit("round_result", { winner: game.winner });
            finalizeRound();
        }
        if (game.time <= 0) {
            game = {
                roundId: `R-${Date.now()}`,
                time: ROUND_TIME, status: "betting", bettingLocked: false,
                winner: null, serverSeed: null, serverSeedHash: null,
                clientSeed: `CLIENT_${Date.now()}`
            };
        }
        await pubClient.publish('game_state_updates', JSON.stringify(game));
        const response = await getGameResponse();
        io.emit("game_update", response);
    }, 1000);
}

// =======================
// ROUTES
// =======================

const mapBet = b => {
    const o = b.toObject ? b.toObject() : b;
    return { ...o, id: o._id, amount: o.amount / 100, payout: o.payout / 100 };
};
const mapTx = t => {
    const o = t.toObject ? t.toObject() : t;
    return { ...o, id: o._id, amount: o.amount / 100, payout: o.payout / 100, balanceAfter: (o.balanceAfter || 0) / 100 };
};

app.get('/game-state', verifyToken, async (req, res) => {
    try {
        const user = await User.findOne({ userId: req.user.uid }) || await User.create({ userId: req.user.uid, balance: 100000 });
        const history = await Round.find().sort({ createdAt: -1 }).limit(20);
        const response = await getGameResponse();
        res.json({ success: true, data: { ...response, balance: user.balance / 100, colorHistory: history.map(r => r.winner), playStreak: user.playStreak, canClaimBonus: !user.lastBonusClaimTime || (new Date() - user.lastBonusClaimTime > 86400000) } });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/bet', verifyToken, validate(schemas.bet), async (req, res) => {
    const { color, amount } = req.body;
    const kobo = Math.floor(amount * 100);
    if (game.status !== "betting" || game.bettingLocked) return res.status(400).json({ success: false, error: "Locked" });
    const session = await mongoose.startSession();
    try {
        let bal = 0; let betObj = null;
        await session.withTransaction(async () => {
            const user = await User.findOneAndUpdate({ userId: req.user.uid, balance: { $gte: kobo } }, { $inc: { balance: -kobo, "stats.totalBets": 1 } }, { session, new: true });
            if (!user) throw new Error("Insufficient funds");
            bal = user.balance;
            const tx = await Transaction.create([{ userId: req.user.uid, type: 'bet', amount: -kobo, balanceAfter: user.balance, status: 'pending', roundId: game.roundId, userColor: color }], { session });
            const b = await Bet.create([{ userId: req.user.uid, username: req.user.email?.split('@')[0] || "User", roundId: game.roundId, color, amount: kobo, transactionId: tx[0]._id }], { session });
            betObj = b[0];
            await pubClient.hIncrBy(`pools:${game.roundId}`, color, kobo);
        });
        io.emit("new_bet", mapBet(betObj));
        res.json({ success: true, data: { balance: bal / 100 } });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); } finally { session.endSession(); }
});

app.post('/initialize-payment', verifyToken, validate(schemas.deposit), async (req, res) => {
    try {
        const r = await paystackAxios.post('/transaction/initialize', { email: req.body.email, amount: Math.floor(req.body.amount * 100), metadata: { userId: req.user.uid } }, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } });
        res.json({ success: true, data: r.data.data });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/verify-payment/:reference', verifyToken, async (req, res) => {
    try {
        const r = await paystackAxios.get(`/transaction/verify/${req.params.reference}`, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } });
        if (r.data.data.status === 'success') {
            const amount = r.data.data.amount;
            const userId = r.data.data.metadata.userId;
            const session = await mongoose.startSession();
            let bal = 0;
            try {
                await session.withTransaction(async () => {
                    const ex = await Transaction.findOne({ reference: req.params.reference }).session(session);
                    if (ex) { bal = (await User.findOne({ userId }).session(session)).balance; return; }
                    const u = await User.findOneAndUpdate({ userId }, { $inc: { balance: amount } }, { session, new: true });
                    bal = u.balance;
                    await Transaction.create([{ userId, type: 'deposit', amount, balanceAfter: u.balance, status: 'success', reference: req.params.reference }], { session });
                });
                res.json({ success: true, data: { balance: bal / 100 } });
            } finally { session.endSession(); }
        } else res.status(400).json({ success: false });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/my-bets', verifyToken, async (req, res) => {
    const bets = await Bet.find({ userId: req.user.uid }).sort({ time: -1 }).limit(50);
    res.json({ success: true, data: bets.map(mapBet) });
});

app.get('/all-bets', verifyToken, async (req, res) => {
    const bets = await Bet.find({ roundId: game.roundId }).sort({ time: -1 }).limit(50);
    res.json({ success: true, data: bets.map(mapBet) });
});

app.get('/top-wins', verifyToken, async (req, res) => {
    const wins = await Transaction.find({ type: 'win', status: 'success' }).sort({ amount: -1 }).limit(20);
    res.json({ success: true, data: wins.map(mapTx) });
});

app.get('/transactions', verifyToken, async (req, res) => {
    const { type } = req.query;
    let q = { userId: req.user.uid };
    if (type === 'game') q.type = { $in: ['bet', 'win'] };
    else if (type === 'finance') q.type = { $in: ['deposit', 'withdrawal', 'bonus'] };
    const txs = await Transaction.find(q).sort({ createdAt: -1 }).limit(50);
    res.json({ success: true, data: txs.map(mapTx) });
});

app.get('/round/:roundId', verifyToken, async (req, res) => {
    const r = await Round.findOne({ roundId: req.params.roundId });
    res.json({ success: true, data: r });
});

app.post('/claim-bonus', verifyToken, async (req, res) => {
    const session = await mongoose.startSession();
    try {
        let bal = 0;
        await session.withTransaction(async () => {
            const u = await User.findOneAndUpdate({ userId: req.user.uid, $or: [{ lastBonusClaimTime: { $lt: new Date(Date.now() - 86400000) } }, { lastBonusClaimTime: null }] }, { $inc: { balance: 10000 }, $set: { lastBonusClaimTime: new Date() } }, { session, new: true });
            if (!u) throw new Error("Already claimed");
            bal = u.balance;
            await Transaction.create([{ userId: req.user.uid, type: 'bonus', amount: 10000, balanceAfter: u.balance }], { session });
        });
        res.json({ success: true, data: { balance: bal / 100 } });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); } finally { session.endSession(); }
});

app.post('/withdraw', verifyToken, validate(schemas.withdraw), async (req, res) => {
    const kobo = Math.floor(req.body.amount * 100);
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            const u = await User.findOneAndUpdate({ userId: req.user.uid, balance: { $gte: kobo } }, { $inc: { balance: -kobo } }, { session, new: true });
            if (!u) throw new Error("Insufficient funds");
            await Transaction.create([{ userId: req.user.uid, type: 'withdrawal', amount: -kobo, balanceAfter: u.balance, status: 'pending', bankDetails: req.body }], { session });
        });
        res.json({ success: true });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); } finally { session.endSession(); }
});

if (MONGO_URI) mongoose.connect(MONGO_URI).then(() => { console.log("✅ DB Connected"); startGameLoop(); });
server.listen(PORT, () => console.log(`🚀 Server running`));
