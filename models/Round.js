const mongoose = require('mongoose');

const RoundSchema = new mongoose.Schema({
    roundId: { type: String, required: true, unique: true },
    status: {
        type: String,
        enum: ['active', 'ended', 'paused', 'result'],
        default: 'active'
    },
    winningColor: { type: String, enum: ['green', 'blue', 'purple', null], default: null },
    totalPool: { type: Number, default: 0 },
    greenPool: { type: Number, default: 0 },
    purplePool: { type: Number, default: 0 },
    bluePool: { type: Number, default: 0 },
    totalPayout: { type: Number, default: 0 },
    houseProfit: { type: Number, default: 0 },
    houseEdge: { type: Number, default: 0 },
    isForced: { type: Boolean, default: false },
    forcedBy: { type: String, default: null },
    forcedAt: { type: Date, default: null },
    forcedReason: { type: String, default: null },
    playerCount: { type: Number, default: 0 },
    colorStats: {
        green: { players: { type: Number, default: 0 }, amount: { type: Number, default: 0 } },
        purple: { players: { type: Number, default: 0 }, amount: { type: Number, default: 0 } },
        blue: { players: { type: Number, default: 0 }, amount: { type: Number, default: 0 } }
    },
    winningPlayers: [{
        username: String,
        userId: String,
        betAmount: Number,
        winningAmount: Number
    }],
    losingPlayers: [{
        username: String,
        userId: String,
        color: String,
        betAmount: Number
    }],
    timeline: {
        startedAt: { type: Date, default: Date.now },
        lockedAt: Date,
        resultAt: Date,
        completedAt: Date
    },
    riskSnapshot: {
        green: Number,
        purple: Number,
        blue: Number
    },
    timestamp: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('Round', RoundSchema);
