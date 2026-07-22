const mongoose = require('mongoose');
const SupportTicket = require('./models/SupportTicket');
const TicketMessage = require('./models/TicketMessage');
const AdminNote = require('./models/AdminNote');

const bonusSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  bonusType: { type: String, required: true }, // e.g., 'WELCOME_BONUS', 'FIRST_DEPOSIT_BONUS', 'REFERRAL_REWARD'
  title: { type: String, required: true },
  description: { type: String },
  amount: { type: Number, required: true }, // Kobo
  status: {
    type: String,
    enum: ['AVAILABLE', 'CLAIMED', 'EXPIRED', 'COMING_SOON'],
    default: 'AVAILABLE'
  },
  earnedAt: { type: Date, default: Date.now },
  claimedAt: { type: Date },
  expiresAt: { type: Date },
  transactionReference: { type: String, unique: true, sparse: true },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const referralHistorySchema = new mongoose.Schema({
  referrerId: { type: String, required: true, index: true },
  referredUserId: { type: String, required: true, unique: true },
  referredUsername: { type: String },
  status: {
    type: String,
    enum: ['INVITED', 'REGISTERED', 'FIRST_DEPOSIT_COMPLETED', 'GAMEPLAY_REQUIREMENT_COMPLETED', 'QUALIFIED', 'REWARD_PAID'],
    default: 'REGISTERED'
  },
  wagerVolume: { type: Number, default: 0 }, // Kobo
  qualified: { type: Boolean, default: false },
  rewardPending: { type: Boolean, default: false },
  rewardAmount: { type: Number, default: 0 },
  rewardPaid: { type: Boolean, default: false },
  rewardPaidAt: { type: Date },
  createdAt: { type: Date, default: Date.now }
});

const referralTransactionSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  referredUserId: { type: String },
  referredUsername: { type: String },
  amount: { type: Number, required: true }, // Kobo
  status: { type: String, default: 'success' },
  reason: { type: String, default: 'Referral Reward' },
  paidAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
});

const configSchema = new mongoose.Schema({
  key: { type: String, unique: true, required: true },
  value: mongoose.Schema.Types.Mixed,
  description: String,
  updatedAt: { type: Date, default: Date.now }
});

const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  email: { type: String, default: "user@example.com" },
  balance: { type: Number, default: 0 }, // KOBO
  playStreak: { type: Number, default: 0 },
  lastBonusClaimTime: { type: Date, default: null },
  isFlagged: { type: Boolean, default: false },
  isAdmin: { type: Boolean, default: false },
  kycStatus: { type: String, enum: ['none', 'pending', 'verified', 'rejected'], default: 'none' },
  lastLogin: { type: Date, default: Date.now },
  totalDeposited: { type: Number, default: 0 },
  totalWithdrawn: { type: Number, default: 0 },
  stats: {
    totalBets: { type: Number, default: 0 },
    totalWins: { type: Number, default: 0 }
  },
  createdAt: { type: Date, default: Date.now },

  // Referral Fields
  referralCode: { type: String, unique: true, sparse: true, index: true },
  referredBy: { type: String, index: true },
  referralStatus: { type: String, default: 'REGISTERED' },
  totalReferrals: { type: Number, default: 0 },
  qualifiedReferrals: { type: Number, default: 0 },
  pendingReferrals: { type: Number, default: 0 },
  referralWallet: { type: Number, default: 0 }, // Dedicated Referral Wallet (Kobo)
  totalReferralEarnings: { type: Number, default: 0 },
  pendingReferralRewards: { type: Number, default: 0 },
  qualifiedReferralRewards: { type: Number, default: 0 },

  // Bonus Fields
  bonusWallet: { type: Number, default: 0 },
  totalBonusEarned: { type: Number, default: 0 },
  totalClaimedBonuses: { type: Number, default: 0 }
});

const betSchema = new mongoose.Schema({
  userId: { type: String, index: true },
  username: { type: String, default: "User" },
  roundId: { type: String, index: true },
  color: String,
  amount: { type: Number, required: true }, // KOBO
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
  username: { type: String },
  type: { type: String, required: true },
  amount: { type: Number, required: true }, // KOBO
  payout: { type: Number, default: 0 },     // KOBO
  balanceAfter: { type: Number },           // KOBO
  description: { type: String },
  status: { type: String, enum: ['pending', 'success', 'failed', 'rejected', 'approved', 'completed', 'paid'], default: 'success' },
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
transactionSchema.index({ status: 1, type: 1 });

const roundSchema = new mongoose.Schema({
  roundId: { type: String, unique: true, index: true },
  winner: String, // Keeping existing field
  winningColor: String, // Audit field
  serverSeed: String,
  serverSeedHash: String,
  clientSeed: String,
  totalPool: { type: Number, default: 0 }, // KOBO
  greenPool: { type: Number, default: 0 }, // KOBO
  purplePool: { type: Number, default: 0 }, // KOBO
  bluePool: { type: Number, default: 0 }, // KOBO
  totalPayout: { type: Number, default: 0 }, // KOBO
  houseProfit: { type: Number, default: 0 }, // KOBO
  houseEdge: { type: Number, default: 0 }, // Percentage
  isForced: { type: Boolean, default: false },
  forcedBy: String,
  forcedAt: Date,
  forcedReason: String,
  forcedWinner: String,
  playerCount: { type: Number, default: 0 },
  colorStats: {
    green: { players: { type: Number, default: 0 }, amount: { type: Number, default: 0 } },
    purple: { players: { type: Number, default: 0 }, amount: { type: Number, default: 0 } },
    blue: { players: { type: Number, default: 0 }, amount: { type: Number, default: 0 } }
  },
  winningPlayers: [{
    username: String,
    userId: String,
    betAmount: Number, // KOBO
    winningAmount: Number // KOBO
  }],
  losingPlayers: [{
    username: String,
    userId: String,
    color: String,
    betAmount: Number // KOBO
  }],
  timeline: {
    startedAt: { type: Date, default: Date.now },
    lockedAt: Date,
    resultAt: Date,
    completedAt: Date
  },
  riskSnapshot: {
    green: Number, // KOBO (Exposure)
    purple: Number, // KOBO
    blue: Number // KOBO
  },
  createdAt: { type: Date, default: Date.now, index: true }
});

roundSchema.index({ createdAt: -1 });
roundSchema.index({ winner: 1 });
roundSchema.index({ winningColor: 1 });
roundSchema.index({ isForced: 1 });

const globalStateSchema = new mongoose.Schema({
    key: { type: String, default: "current" },
    roundId: String,
    time: { type: Number, default: 30 },
    status: { type: String, default: "betting" },
    bettingLocked: { type: Boolean, default: false },
    lastWinner: String,
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
  Round: mongoose.model('Round', roundSchema),
  RoundHistory: mongoose.model('Round', roundSchema), // Alias
  GlobalState: mongoose.model('GlobalState', globalStateSchema),
  ReferralHistory: mongoose.model('ReferralHistory', referralHistorySchema),
  ReferralTransaction: mongoose.model('ReferralTransaction', referralTransactionSchema),
  Config: mongoose.model('Config', configSchema),
  Bonus: mongoose.model('Bonus', bonusSchema),
  SupportTicket,
  TicketMessage,
  AdminNote
};
