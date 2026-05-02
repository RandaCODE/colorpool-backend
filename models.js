const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  email: { type: String, default: "user@example.com" },
  balance: { type: Number, default: 100000 },
  playStreak: { type: Number, default: 0 },
  lastBonusClaimTime: { type: Date, default: null },
  isFlagged: { type: Boolean, default: false },
  stats: {
    totalBets: { type: Number, default: 0 },
    totalWins: { type: Number, default: 0 }
  }
});

const betSchema = new mongoose.Schema({
  userId: String,
  roundId: String,
  color: String,
  amount: Number,
  time: { type: Date, default: Date.now }
});

const transactionSchema = new mongoose.Schema({
  userId: String,
  type: { type: String, enum: ['bet', 'win', 'deposit', 'withdraw', 'bonus'] },
  amount: Number,
  balanceAfter: Number,
  description: String,
  status: { type: String, enum: ['pending', 'success', 'failed'], default: 'success' },
  reference: { type: String, unique: true, sparse: true },
  bankDetails: {
    accountNumber: String,
    bankName: String
  },
  createdAt: { type: Date, default: Date.now }
});

const globalStateSchema = new mongoose.Schema({
    key: { type: String, default: "current" },
    roundId: String,
    time: { type: Number, default: 23 },
    status: { type: String, default: "betting" },
    bettingLocked: { type: Boolean, default: false },
    lastWinner: String,
    calculatedWinner: String,
    pools: {
        green: { type: Number, default: 0 },
        purple: { type: Number, default: 0 },
        blue: { type: Number, default: 0 }
    }
});

module.exports = {
  User: mongoose.model('User', userSchema),
  Bet: mongoose.model('Bet', betSchema),
  Transaction: mongoose.model('Transaction', transactionSchema),
  GlobalState: mongoose.model('GlobalState', globalStateSchema)
};
