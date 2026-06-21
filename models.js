const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  email: { type: String, default: "user@example.com" },
  balance: { type: Number, default: 0 }, // ALWAYS STORED IN KOBO (Integer)
  playStreak: { type: Number, default: 0 },
  lastBonusClaimTime: { type: Date, default: null },
  isFlagged: { type: Boolean, default: false },
  isAdmin: { type: Boolean, default: false },
  lastLogin: { type: Date, default: Date.now },
  totalDeposited: { type: Number, default: 0 },
  totalWithdrawn: { type: Number, default: 0 },
  stats: {
    totalBets: { type: Number, default: 0 },
    totalWins: { type: Number, default: 0 }
  },
  createdAt: { type: Date, default: Date.now } // Added for Admin "New Users Today"
});

const betSchema = new mongoose.Schema({
  userId: { type: String, index: true },
  username: { type: String, default: "User" },
  roundId: { type: String, index: true },
  color: String,
  amount: { type: Number, required: true }, // STORED IN KOBO
  transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
  settled: { type: Boolean, default: false, index: true },
  result: { type: String, enum: ['WON', 'LOST', 'PENDING'], default: 'PENDING' },
  payout: { type: Number, default: 0 },
  time: { type: Date, default: Date.now }
});

betSchema.index({ userId: 1, time: -1 });
betSchema.index({ roundId: 1, settled: 1 });

const transactionSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  username: { type: String }, // Added for Top Wins feed
  type: { type: String, required: true },
  amount: { type: Number, required: true }, // STORED IN KOBO (Bet amount for wins, total for others)
  payout: { type: Number, default: 0 },     // STORED IN KOBO (Total payout for wins)
  balanceAfter: { type: Number },           // STORED IN KOBO
  description: { type: String },
  status: { type: String, enum: ['pending', 'success', 'failed', 'rejected'], default: 'success' },
  reference: { type: String, unique: true, sparse: true },
  bankDetails: {
    accountNumber: String,
    bankName: String,
    bankCode: String,
    accountName: String
  },
  adminNotes: String,
  processedBy: String,
  roundId: { type: String },
  winningColor: { type: String },
  userColor: { type: String },
  createdAt: { type: Date, default: Date.now }
});

transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ userId: 1, type: 1, createdAt: -1 });
transactionSchema.index({ status: 1, type: 1 });

const webhookEventSchema = new mongoose.Schema({
  event: String,
  reference: { type: String, unique: true, index: true },
  payload: Object,
  processed: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
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
  totalBets: { type: Number, default: 0 },
  totalPayout: { type: Number, default: 0 },
  houseProfit: { type: Number, default: 0 },
  isForced: { type: Boolean, default: false },
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
  WebhookEvent: mongoose.model('WebhookEvent', webhookEventSchema),
  GlobalState: mongoose.model('GlobalState', globalStateSchema),
  Round: mongoose.model('Round', roundSchema)
};
