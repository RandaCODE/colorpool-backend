const mongoose = require('mongoose');

const GlobalStateSchema = new mongoose.Schema({
    roundId: { type: mongoose.Schema.Types.ObjectId, ref: 'Round' },
    time: { type: Number, default: 30 },
    status: { type: String, enum: ['waiting', 'betting', 'rolling', 'ended'], default: 'waiting' },
    bettingLocked: { type: Boolean, default: false },
    forcedWinner: { type: String, enum: ['green', 'purple', 'blue', null], default: null },
    pools: {
        green: { type: Number, default: 0 },
        purple: { type: Number, default: 0 },
        blue: { type: Number, default: 0 }
    },
    updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('GlobalState', GlobalStateSchema);
