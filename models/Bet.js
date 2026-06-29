const mongoose = require('mongoose');

const BetSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    roundId: { type: mongoose.Schema.Types.ObjectId, ref: 'Round', required: true },
    color: { type: String, enum: ['green', 'blue', 'purple'], required: true },
    amount: { type: Number, required: true },
    payout: { type: Number, default: 0 },
    status: { type: String, enum: ['pending', 'won', 'lost'], default: 'pending' },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Bet', BetSchema);
