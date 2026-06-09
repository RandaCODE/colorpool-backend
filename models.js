const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  email: { type: String, default: "user@example.com" },
  balance: { type: Number, default: 0 },
  playStreak: { type: Number, default: 0 },
  lastBonusClaimTime: { type: Date, default: null },
  isFlagged: { type: Boolean, default: false },
  stats: {
    totalBets: { type: Number, default: 0 },
    totalWins: { type: Number, default: 0 }
  }
});

const betSchema = new mongoose.Schema({
  userId: { type: String, index: true },
  roundId: { type: String, index: true },
  color: String,
  amount: Number,
  transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
  time: { type: Date, default: Date.now }
});

const transactionSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  // type: 'bet', 'win', 'deposit', 'withdrawal', 'bonus'
  type: { type: String, required: true, index: true },
  amount: { type: Number, required: true },
  payout: { type: Number, default: 0 }, // Added for easy history retrieval
  balanceAfter: { type: Number },
  description: { type: String },
  status: { type: String, enum: ['pending', 'success', 'failed'], default: 'success' },
  reference: { type: String, unique: true, sparse: true }, // For Paystack
  bankDetails: {
    accountNumber: String,
    bankName: String
  },
  // Game Context
  roundId: { type: String, index: true },
  winningColor: { type: String },
  userColor: { type: String },
  createdAt: { type: Date, default: Date.now, index: true }
});

const roundSchema = new mongoose.Schema({
  roundId: { type: String, unique: true, index: true },
  winner: String,
  serverSeed: String,
  serverSeedHash: String,
  clientSeed: String,
  pools: {
    green: { type: Number, default: 0 },
    purple: { type: Number, default: 0 },
    blue: { type: Number, default: 0 }
  },
  createdAt: { type: Date, default: Date.now, index: true }
});

const globalStateSchema = new mongoose.Schema({
    key: { type: String, default: "current" },
    roundId: String,
    time: { type: Number, default: 30 },
    status: { type: String, default: "betting" },
    bettingLocked: { type: Boolean, default: false },
    lastWinner: String,
    serverSeed: String,
    serverSeedHash: String,
    clientSeed: String,
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
  GlobalState: mongoose.model('GlobalState', globalStateSchema),
  Round: mongoose.model('Round', roundSchema)
};
