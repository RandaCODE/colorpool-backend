const mongoose = require('mongoose');
const SupportTicket = require('./models/SupportTicket');
const TicketMessage = require('./models/TicketMessage');
const AdminNote = require('./models/AdminNote');

const campaignSchema = new mongoose.Schema({
  campaignId: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  description: { type: String },
  bannerUrl: { type: String },
  type: {
    type: String,
    enum: ['DEPOSIT_BONUS', 'CASHBACK_BONUS', 'WEEKEND_BONUS', 'HOLIDAY_BONUS', 'REFERRAL_CAMPAIGN', 'TOURNAMENT_BONUS', 'LOYALTY_BONUS', 'PROMOTIONAL', 'BIRTHDAY', 'SEASONAL'],
    required: true
  },
  status: {
    type: String,
    enum: ['ACTIVE', 'SCHEDULED', 'ENDED', 'PAUSED', 'COMING_SOON', 'EXPIRED'],
    default: 'SCHEDULED'
  },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  rewardAmount: { type: Number, default: 0 }, // Kobo
  rewardType: { type: String, default: 'BONUS_WALLET' },
  eligibilityRules: {
    minDeposit: { type: Number, default: 0 },
    maxDeposit: { type: Number, default: 0 },
    minBets: { type: Number, default: 0 },
    registrationDateAfter: { type: Date },
    accountVerified: { type: Boolean, default: false },
    referralCount: { type: Number, default: 0 },
    birthdayClaimWindow: { type: Number, default: 0 } // Days before/after birthday
  },
  conversionRules: {
    wageringMultiplier: { type: Number, default: 0 }, // e.g., 3x bonus amount
    minRounds: { type: Number, default: 0 },
    minStake: { type: Number, default: 0 }, // Minimum total stake required
    expiryDays: { type: Number, default: 30 }
  },
  priority: { type: Number, default: 0 },
  maxClaims: { type: Number, default: 0 }, // 0 for unlimited
  currentClaims: { type: Number, default: 0 },
  termsAndConditions: { type: String },
  claimMethod: { type: String, enum: ['AUTO', 'CLAIM_BUTTON'], default: 'AUTO' },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const bonusSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  bonusType: { type: String, required: true },
  campaignId: { type: String, index: true },
  title: { type: String, required: true },
  description: { type: String },
  amount: { type: Number, required: true }, // Kobo
  status: {
    type: String,
    enum: ['AVAILABLE', 'CLAIMED', 'EXPIRED', 'COMING_SOON'],
    default: 'AVAILABLE'
  },
  // Conversion Tracking
  conversionStatus: {
    type: String,
    enum: ['LOCKED', 'IN_PROGRESS', 'READY_TO_CONVERT', 'CONVERTED', 'EXPIRED'],
    default: 'LOCKED'
  },
  wageringRequired: { type: Number, default: 0 },
  wageringAchieved: { type: Number, default: 0 },
  roundsRequired: { type: Number, default: 0 },
  roundsPlayed: { type: Number, default: 0 },
  conversionReference: { type: String, unique: true, sparse: true },
  convertedAt: { type: Date },

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
  dob: { type: Date }, // Date of Birth
  balance: { type: Number, default: 0 }, // KOBO
  playStreak: { type: Number, default: 0 },
  lastBonusClaimTime: { type: Date, default: null },
  isFlagged: { type: Boolean, default: false },
  isAdmin: { type: Boolean, default: false },
  kycStatus: { type: String, enum: ['none', 'pending', 'verified', 'rejected'], default: 'none' },
  lastLogin: { type: Date, default: Date.now },
  totalDeposited: { type: Number, default: 0 },
  totalWithdrawn: { type: Number, default: 0 },
  totalWagered: { type: Number, default: 0 }, // Total global wager volume (Kobo)
  isWithdrawalRestricted: { type: Boolean, default: false },
  withdrawalRestrictionReason: { type: String },
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
  Campaign: mongoose.model('Campaign', campaignSchema),
  SupportTicket,
  TicketMessage,
  AdminNote
};
