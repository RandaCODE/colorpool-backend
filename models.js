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
  idempotencyKey: { type: String, unique: true, sparse: true, index: true },
  createdAt: { type: Date, default: Date.now, index: true }
});

const roundSchema = new mongoose.Schema({
  roundId: { type: String, unique: true, index: true },
  winner: String,
  winningColor: String,
  serverSeed: String,
  serverSeedHash: String,
  clientSeed: String,
  forcedWinner: { type: String, default: null },
  forcedBy: { type: String, default: null },
  forcedAt: { type: Date, default: null },
  forcedReason: { type: String, default: null },
  isForced: { type: Boolean, default: false },
  totalPool: { type: Number, default: 0 },
  greenPool: { type: Number, default: 0 },
  purplePool: { type: Number, default: 0 },
  bluePool: { type: Number, default: 0 },
  totalBets: { type: Number, default: 0 },
  totalPayout: { type: Number, default: 0 },
  houseProfit: { type: Number, default: 0 },
  houseEdge: { type: Number, default: 0 },
  playerCount: { type: Number, default: 0 },
  pools: {
    green: { type: Number, default: 0 },
    purple: { type: Number, default: 0 },
    blue: { type: Number, default: 0 }
  },
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
    startedAt: Date,
    lockedAt: Date,
    resultAt: Date,
    completedAt: Date
  },
  riskSnapshot: {
    green: Number,
    purple: Number,
    blue: Number
  },
  timestamp: { type: Date, default: Date.now },
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
