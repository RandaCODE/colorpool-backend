const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const dns = require('dns');
const axios = require('axios');
const crypto = require('crypto');
const admin = require('firebase-admin');
const http = require('http');
const { Server } = require("socket.io");
const { User, Bet, Transaction, GlobalState, Round, WebhookEvent } = require("./models");

// Force stable DNS for MongoDB Atlas
dns.setServers(['8.8.8.8', '8.8.4.4']);

// CONFIG: Explicit timeouts for external APIs (Paystack)
const paystackAxios = axios.create({
    baseURL: 'https://api.paystack.co',
    timeout: 30000,
});

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
const io = new Server(server, {
    cors: { origin: "*" },
    pingTimeout: 60000,
    pingInterval: 25000,
    allowEIO3: true
});

// =======================
// SOCKET.IO CONNECTION
// =======================
io.on("connection", (socket) => {
    const userId = socket.handshake.query.userId;
    if (userId && userId !== 'null' && userId !== 'undefined') {
        socket.join(userId);
        console.log(`🔌 [Socket] User joined room: ${userId}`);

        // Push current game state immediately on join
        socket.emit("game_update", { ...game, serverSeed: undefined });
    }
});

// =======================
// MIDDLEWARE & LOGGING
// =======================
app.use(cors());

// Capture raw body for Paystack signature verification
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} (${duration}ms)`);
    });
    next();
});

// =======================
// CONFIGURATION
// =======================
const PORT = process.env.PORT || 3000;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const MONGO_URI = process.env.MONGO_URI;

// =======================
// DATABASE CONNECTION
// =======================
if (MONGO_URI) {
    console.log("⏳ Connecting to MongoDB...");
    mongoose.connect(MONGO_URI, {
        serverSelectionTimeoutMS: 45000,
        connectTimeoutMS: 45000
    });

    mongoose.connection.on('connected', () => {
        console.log("✅ MongoDB Connected Successfully");
        initializeGame();
    });

    mongoose.connection.on('error', (err) => {
        console.error("❌ MongoDB Connection Error:", err.message);
    });
}

// =======================
// AUTH MIDDLEWARE
// =======================
async function verifyToken(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, error: 'Authentication required. Please login again.' });
        }

        const token = authHeader.split('Bearer ')[1];

        if (!firebaseConfigured) {
            console.error("❌ Security Alert: Attempted auth while Firebase is not configured.");
            return res.status(500).json({ success: false, error: 'Internal Authentication Service Error' });
        }

        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken;
        next();
    } catch (error) {
        console.error("❌ Auth Error:", error.message);
        return res.status(401).json({ success: false, error: 'Invalid or expired session' });
    }
}

// =======================
// UTILS
// =======================
const getUsername = (user) => {
    if (!user) return "User";
    if (user.email && user.email.includes('@')) return user.email.split('@')[0];
    return user.userId.substring(0, 5);
};

// =======================
// GAME ENGINE CONSTANTS
// =======================
const PROBABILITIES = { green: 0.52, purple: 0.28, blue: 0.20 };
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
    clientSeed: `CLIENT_${Date.now()}`,
    pools: { green: 0, purple: 0, blue: 0 }
};

let secretCalculatedWinner = null;

function generateServerSeed() { return crypto.randomBytes(32).toString('hex'); }
function hashSeed(seed) { return crypto.createHash('sha256').update(seed).digest('hex'); }

function determineWinner(serverSeed, clientSeed, roundId) {
    const combined = `${serverSeed}:${clientSeed}:${roundId}`;
    const hash = crypto.createHash('sha256').update(combined).digest('hex');
    const num = parseInt(hash.substring(0, 8), 16) / 0xffffffff;
    if (num < PROBABILITIES.green) return "green";
    if (num < (PROBABILITIES.green + PROBABILITIES.purple)) return "purple";
    return "blue";
}

async function initializeGame() {
    try {
        const saved = await GlobalState.findOne({ key: "current" });
        if (saved && saved.status !== "result") {
            game = { ...game, ...saved.toObject() };
        }
    } catch (e) { console.error("[Engine] State Restore Error:", e.message); }

    if (!game.serverSeed) {
        game.serverSeed = generateServerSeed();
        game.serverSeedHash = hashSeed(game.serverSeed);
    }
    startGameLoop();
}

async function finalizeRound() {
    const winner = game.winner;
    const roundId = game.roundId;
    console.log(`🎯 [Engine] Finalizing Round ${roundId}. Winner: ${winner.toUpperCase()}`);

    try {
        // 1. Check if Round already exists to prevent duplicate overall settlement
        const existingRound = await Round.findOne({ roundId });
        if (existingRound) {
            console.log(`⚠️ [Engine] Round ${roundId} already finalized. Skipping.`);
            return;
        }

        // 2. Create Round Record
        await Round.create({
            roundId, winner, serverSeed: game.serverSeed, serverSeedHash: game.serverSeedHash,
            clientSeed: game.clientSeed, pools: game.pools
        });

        // 3. Fetch only non-settled bets for this round
        const allBetsInRound = await Bet.find({ roundId, settled: false });

        // 4. Process each bet atomically
        for (const bet of allBetsInRound) {
            // Atomically mark as settled BEFORE payout to prevent double-pay on concurrent re-runs
            const processLock = await Bet.findOneAndUpdate(
                { _id: bet._id, settled: false },
                { $set: { settled: true } },
                { new: true }
            );

            if (!processLock) continue; // Already processed by another worker or thread

            const isWinner = bet.color.toLowerCase() === winner.toLowerCase();
            const user = await User.findOne({ userId: bet.userId });
            const username = getUsername(user);

            if (isWinner) {
                const payout = bet.amount * multipliers[winner];

                // Atomically update user balance and stats
                const updatedUser = await User.findOneAndUpdate(
                    { userId: bet.userId },
                    { $inc: { balance: payout, "stats.totalWins": 1 } },
                    { new: true }
                );

                // Create Win Transaction
                await Transaction.create({
                    userId: bet.userId,
                    type: 'win',
                    amount: payout,
                    balanceAfter: updatedUser.balance,
                    description: `Win on ${winner.toUpperCase()}`,
                    status: 'success',
                    roundId,
                    winningColor: winner,
                    userColor: bet.color
                });

                // Update Bet Transaction to success using the specific transactionId if available
                const betTxUpdate = { $set: { status: 'success', winningColor: winner, payout: payout } };
                if (bet.transactionId) {
                    await Transaction.findByIdAndUpdate(bet.transactionId, betTxUpdate);
                } else {
                    await Transaction.findOneAndUpdate(
                        { userId: bet.userId, roundId, type: 'bet', userColor: bet.color, status: 'pending' },
                        betTxUpdate
                    );
                }

                // Real-time updates
                io.to(bet.userId).emit("balance_update", { balance: updatedUser.balance });
                io.to(bet.userId).emit("transaction_update");
                io.emit("bet_settled", {
                    id: bet.transactionId || bet._id,
                    userId: bet.userId,
                    username,
                    amount: bet.amount,
                    result: "WON",
                    payout,
                    roundId,
                    color: bet.color
                });
            } else {
                // Update Bet Transaction to reflected loss
                const betTxUpdate = { $set: { status: 'success', winningColor: winner, payout: 0 } };
                if (bet.transactionId) {
                    await Transaction.findByIdAndUpdate(bet.transactionId, betTxUpdate);
                } else {
                    await Transaction.findOneAndUpdate(
                        { userId: bet.userId, roundId, type: 'bet', userColor: bet.color, status: 'pending' },
                        betTxUpdate
                    );
                }

                io.to(bet.userId).emit("transaction_update");
                io.emit("bet_settled", {
                    id: bet.transactionId || bet._id,
                    userId: bet.userId,
                    username,
                    amount: bet.amount,
                    result: "LOST",
                    roundId,
                    color: bet.color
                });
            }
        }
        console.log(`✅ [Engine] Round ${roundId} settled successfully.`);
    } catch (e) {
        console.error(`❌ [Engine] Settlement Error for ${roundId}:`, e.message);
    }
}

function startGameLoop() {
    setInterval(async () => {
        game.time--;

        if (game.time === ROUND_TIME - 1) {
            io.emit("round_hash", { hash: game.serverSeedHash });
        }

        if (game.time === LOCK_AT) {
            game.bettingLocked = true;
            game.status = "locked";
            secretCalculatedWinner = determineWinner(game.serverSeed, game.clientSeed, game.roundId);
        }

        if (game.time === RESULT_AT) {
            game.status = "result";
            game.winner = secretCalculatedWinner;
            io.emit("round_result", { winner: game.winner });
            finalizeRound();
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
            io.emit("pool_update", game.pools);
            io.emit("round_reset", { roundId: game.roundId });
        }

        // Broadcast state to all users
        io.emit("game_update", { ...game, serverSeed: undefined });

        // Persist state to DB
        GlobalState.updateOne({ key: "current" }, { ...game }, { upsert: true }).catch(() => {});
    }, 1000);
}

// =======================
// API ROUTES
// =======================

app.get('/health', (req, res) => {
    res.json({ success: true, status: "online", db: mongoose.connection.readyState });
});

app.get('/game-state', verifyToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        let user = await User.findOne({ userId });
        if (!user) user = await User.create({ userId, balance: 1000 }); // Give starting balance for testing

        const recentRounds = await Round.find().sort({ createdAt: -1 }).limit(20);
        res.json({
            success: true,
            data: {
                ...game,
                balance: user?.balance || 0,
                playStreak: user?.playStreak || 0,
                colorHistory: recentRounds.map(r => r.winner),
                canClaimBonus: user ? (Date.now() - (user.lastBonusClaimTime || 0) > 86400000) : false
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: "Failed to fetch game state" });
    }
});

app.get('/transactions', verifyToken, async (req, res) => {
    const { type } = req.query;
    try {
        console.log(
          '[TX DEBUG]',
          req.user.uid,
          type,
          await Transaction.countDocuments({ userId: req.user.uid })
        );
        let filter = { userId: req.user.uid };
        if (type === 'game') filter.type = { $in: ['bet', 'win'] };
        else if (type === 'finance') filter.type = { $in: ['deposit', 'withdrawal', 'bonus'] };

        const txs = await Transaction.find(filter).sort({ createdAt: -1 }).limit(50);
        res.json({ success: true, data: txs });
    } catch (e) {
        res.status(500).json({ success: false, error: "Failed to fetch transactions" });
    }
});

app.get('/my-bets', verifyToken, async (req, res) => {
    try {
        const bets = await Transaction.find({ userId: req.user.uid, type: 'bet' }).sort({ createdAt: -1 }).limit(50);
        const data = bets.map(b => ({
            id: b._id,
            amount: Math.abs(b.amount),
            color: b.userColor,
            result: b.winningColor ? (b.winningColor === b.userColor ? "WON" : "LOST") : "PENDING",
            payout: b.payout,
            roundId: b.roundId,
            time: b.createdAt
        }));
        res.json({ success: true, data });
    } catch (e) {
        res.status(500).json({ success: false, error: "Failed to fetch bets" });
    }
});

app.get('/all-bets', async (req, res) => {
    try {
        // Only return bets for the current active round
        const bets = await Transaction.find({
            type: 'bet',
            roundId: game.roundId
        }).sort({ createdAt: -1 }).limit(50);

        const userIds = [...new Set(bets.map(b => b.userId))];
        const users = await User.find({ userId: { $in: userIds } });
        const userMap = users.reduce((acc, u) => ({ ...acc, [u.userId]: u }), {});

        const enriched = bets.map(b => ({
            id: b._id,
            userId: b.userId,
            username: getUsername(userMap[b.userId]),
            amount: Math.abs(b.amount),
            color: b.userColor,
            result: b.winningColor ? (b.winningColor === b.userColor ? "WON" : "LOST") : "PENDING",
            payout: b.payout,
            roundId: b.roundId,
            createdAt: b.createdAt
        }));
        res.json({ success: true, data: enriched });
    } catch (e) {
        res.status(500).json({ success: false, error: "Failed to fetch all bets" });
    }
});

app.get('/round/:roundId', async (req, res) => {
    try {
        const round = await Round.findOne({ roundId: req.params.roundId });
        if (!round) {
            return res.status(404).json({ success: false, error: "Round not found" });
        }
        res.json({
            success: true,
            data: {
                roundId: round.roundId,
                serverSeed: round.serverSeed,
                serverSeedHash: round.serverSeedHash,
                clientSeed: round.clientSeed,
                winningColor: round.winner,
                createdAt: round.createdAt
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: "Failed to fetch round data" });
    }
});

app.get('/top-wins', async (req, res) => {
    try {
        const wins = await Transaction.find({ type: 'win' }).sort({ amount: -1 }).limit(10);
        const userIds = [...new Set(wins.map(w => w.userId))];
        const users = await User.find({ userId: { $in: userIds } });
        const userMap = users.reduce((acc, u) => ({ ...acc, [u.userId]: u }), {});

        const enriched = wins.map(w => {
            const mult = multipliers[w.winningColor?.toLowerCase()] || 2;
            const payout = w.amount;
            const betAmount = payout / mult;
            return {
                username: getUsername(userMap[w.userId]),
                payout: payout,
                amount: betAmount,
                profit: payout - betAmount,
                color: w.winningColor,
                createdAt: w.createdAt
            };
        });
        res.json({ success: true, data: enriched });
    } catch (e) {
        res.status(500).json({ success: false, error: "Failed to fetch top wins" });
    }
});

app.post('/bet', verifyToken, async (req, res) => {
    const { color, amount } = req.body;

    // SECURITY FIX: Capture roundId locally to prevent drift
    const activeRoundId = game.roundId;

    if (game.status !== "betting" || game.bettingLocked) {
        return res.status(400).json({ success: false, error: "Round is locked or not in betting phase" });
    }

    // SECURITY FIX: Explicitly ensure amount is a positive integer
    const betAmount = Math.floor(Number(amount));
    if (!betAmount || betAmount < 100) {
        return res.status(400).json({ success: false, error: "Minimum bet is 100" });
    }

    try {
        // Atomic balance check and deduction
        const user = await User.findOneAndUpdate(
            { userId: req.user.uid, balance: { $gte: betAmount } },
            { $inc: { balance: -betAmount, "stats.totalBets": 1 } },
            { new: true }
        );

        if (!user) return res.status(400).json({ success: false, error: "Insufficient balance" });

        // Create transaction record using the captured activeRoundId
        const tx = await Transaction.create({
            userId: req.user.uid,
            type: 'bet',
            amount: -betAmount,
            balanceAfter: user.balance,
            description: `Bet on ${color.toUpperCase()}`,
            status: 'pending',
            roundId: activeRoundId,
            userColor: color.toLowerCase()
        });

        // Record bet for pool logic, linking the transaction
        await Bet.create({
            userId: req.user.uid,
            roundId: activeRoundId,
            color: color.toLowerCase(),
            amount: betAmount,
            transactionId: tx._id
        });

        // Update live pools (only if round hasn't flipped, or we update the pool for the specific round)
        // Note: Global pools are for display only, settlement uses the Bet records.
        if (game.roundId === activeRoundId) {
            game.pools[color.toLowerCase()] += betAmount;
            io.emit("pool_update", game.pools);
        }

        // Broadcast updates
        io.to(req.user.uid).emit("balance_update", { balance: user.balance });
        io.to(req.user.uid).emit("transaction_update");
        io.emit("new_bet", {
            id: tx._id,
            userId: req.user.uid,
            username: getUsername(user),
            amount: betAmount,
            color: color.toLowerCase(),
            roundId: activeRoundId,
            result: "PENDING"
        });

        res.json({ success: true, data: { balance: user.balance } });
    } catch (e) {
        console.error("🚨 Bet Error:", e.message);
        res.status(500).json({ success: false, error: "Internal server error during betting" });
    }
});

app.post('/initialize-payment', verifyToken, async (req, res) => {
    const { email, amount } = req.body;
    if (!email || !amount) {
        return res.status(400).json({ success: false, error: "Email and amount are required" });
    }

    try {
        const response = await paystackAxios.post('/transaction/initialize', {
            email,
            amount: Math.floor(amount * 100), // Convert to Kobo
            callback_url: "https://your-domain.com/verify-payment", // Optional callback
            metadata: {
                userId: req.user.uid,
                custom_fields: [
                    { display_name: "User ID", variable_name: "user_id", value: req.user.uid }
                ]
            }
        }, {
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
        });

        res.json({ success: true, data: response.data.data });
    } catch (e) {
        console.error("🚨 Payment Init Error:", e.response?.data || e.message);
        res.status(500).json({ success: false, error: "Payment gateway unavailable" });
    }
});

app.post('/paystack/webhook', async (req, res) => {
    // 1. Verify Signature
    const hash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY)
        .update(req.rawBody)
        .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
        console.warn("⚠️ [Webhook] Invalid Signature detected.");
        return res.status(401).send('Invalid signature');
    }

    const event = req.body;
    if (event.event !== 'charge.success') {
        return res.sendStatus(200); // We only care about successful charges
    }

    const { reference, amount, metadata } = event.data;
    const userId = metadata?.userId;

    if (!userId) {
        console.error("❌ Webhook Error: No userId in metadata for ref:", reference);
        return res.sendStatus(200);
    }

    try {
        // 2. Check for duplicate processing in WebhookEvent log
        const existingEvent = await WebhookEvent.findOne({ reference });
        if (existingEvent && existingEvent.processed) {
            return res.sendStatus(200);
        }

        // 3. Double check Transaction record for idempotency
        const existingTx = await Transaction.findOne({ reference });
        if (existingTx) {
            if (!existingEvent) {
                await WebhookEvent.create({ event: event.event, reference, payload: event, processed: true });
            } else {
                existingEvent.processed = true;
                await existingEvent.save();
            }
            return res.sendStatus(200);
        }

        const amountInNaira = amount / 100;

        // 4. Atomic balance update
        const user = await User.findOneAndUpdate(
            { userId },
            { $inc: { balance: amountInNaira } },
            { new: true, upsert: true }
        );

        // 5. Record transaction record
        await Transaction.create({
            userId,
            type: 'deposit',
            amount: amountInNaira,
            balanceAfter: user.balance,
            description: 'Deposit via Paystack (Webhook)',
            status: 'success',
            reference
        });

        // 6. Mark webhook event as processed
        if (existingEvent) {
            existingEvent.processed = true;
            await existingEvent.save();
        } else {
            await WebhookEvent.create({ event: event.event, reference, payload: event, processed: true });
        }

        // 7. Push real-time updates
        io.to(userId).emit("balance_update", { balance: user.balance });
        io.to(userId).emit("transaction_update");

        console.log(`✅ [Webhook] Payment Credited: ${amountInNaira} to ${userId} (Ref: ${reference})`);
        res.sendStatus(200);
    } catch (e) {
        console.error("🚨 Webhook Processing Error:", e.message);
        res.sendStatus(500);
    }
});

app.get('/verify-payment/:reference', verifyToken, async (req, res) => {
    const { reference } = req.params;
    try {
        const response = await paystackAxios.get(`/transaction/verify/${reference}`, {
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
        });

        const data = response.data.data;
        if (data.status === 'success') {
            const amountInNaira = data.amount / 100;
            const userId = data.metadata.userId;

            // Check if transaction already processed
            const existingTx = await Transaction.findOne({ reference });
            if (existingTx) {
                const user = await User.findOne({ userId });
                return res.json({ success: true, balance: user.balance, message: "Payment already processed" });
            }

            // Atomic balance update
            const user = await User.findOneAndUpdate(
                { userId },
                { $inc: { balance: amountInNaira } },
                { new: true, upsert: true }
            );

            // Record transaction
            await Transaction.create({
                userId,
                type: 'deposit',
                amount: amountInNaira,
                balanceAfter: user.balance,
                description: 'Deposit via Paystack',
                status: 'success',
                reference
            });

            io.to(userId).emit("balance_update", { balance: user.balance });
            io.to(userId).emit("transaction_update");

            return res.json({ success: true, balance: user.balance });
        }
        res.status(400).json({ success: false, error: "Payment not successful" });
    } catch (e) {
        console.error("🚨 Verify Error:", e.response?.data || e.message);
        res.status(500).json({ success: false, error: "Verification failed" });
    }
});

app.post('/withdraw', verifyToken, async (req, res) => {
    const { amount, bankName, accountNumber } = req.body;
    if (!amount || amount < 2000) return res.status(400).json({ success: false, error: "Minimum withdrawal is 2000" });

    try {
        const user = await User.findOneAndUpdate(
            { userId: req.user.uid, balance: { $gte: amount } },
            { $inc: { balance: -amount } },
            { new: true }
        );

        if (!user) return res.status(400).json({ success: false, error: "Insufficient balance" });

        await Transaction.create({
            userId: req.user.uid,
            type: 'withdrawal',
            amount: -amount,
            balanceAfter: user.balance,
            description: `Withdrawal to ${bankName}`,
            status: 'pending',
            bankDetails: { bankName, accountNumber }
        });

        io.to(req.user.uid).emit("balance_update", { balance: user.balance });
        io.to(req.user.uid).emit("transaction_update");

        res.json({ success: true, balance: user.balance });
    } catch (e) {
        res.status(500).json({ success: false, error: "Withdrawal failed" });
    }
});

app.post('/claim-bonus', verifyToken, async (req, res) => {
    try {
        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - 86400000);

        const bonus = 100;

        // SECURITY FIX: Atomic once-per-day check using findOneAndUpdate query
        const updatedUser = await User.findOneAndUpdate(
            {
                userId: req.user.uid,
                $or: [
                    { lastBonusClaimTime: { $lt: oneDayAgo } },
                    { lastBonusClaimTime: null }
                ]
            },
            {
                $inc: { balance: bonus },
                $set: { lastBonusClaimTime: now }
            },
            { new: true }
        );

        if (!updatedUser) {
            return res.status(400).json({ success: false, error: "Bonus already claimed today" });
        }

        await Transaction.create({
            userId: req.user.uid,
            type: 'bonus',
            amount: bonus,
            balanceAfter: updatedUser.balance,
            description: 'Daily Bonus',
            status: 'success'
        });

        io.to(req.user.uid).emit("balance_update", { balance: updatedUser.balance });
        io.to(req.user.uid).emit("transaction_update");

        res.json({ success: true, balance: updatedUser.balance });
    } catch (e) {
        console.error("🚨 Bonus Error:", e.message);
        res.status(500).json({ success: false, error: "Bonus claim failed" });
    }
});

server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
