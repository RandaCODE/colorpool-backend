const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const { User, Bonus, ReferralHistory, ReferralTransaction, Config, Campaign } = require('../models');
const { checkEligibility, claimCampaignReward } = require('../utils/campaignProcessor');
const { convertBonusToMain, checkWithdrawalEligibility } = require('../utils/conversionProcessor');

// Middleware to verify Firebase token
async function verifyToken(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ success: false, error: 'Unauthorized' });
        const decodedToken = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
        req.user = decodedToken;
        next();
    } catch (error) { return res.status(401).json({ success: false, error: 'Invalid session' }); }
}

// @route   GET /bonuses/summary
// @desc    Get bonus wallet summary
router.get('/summary', verifyToken, async (req, res) => {
    try {
        const user = await User.findOne({ userId: req.user.uid });
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });

        res.json({
            success: true,
            data: {
                bonusWallet: (user.bonusWallet || 0) / 100,
                totalBonusEarned: (user.totalBonusEarned || 0) / 100,
                totalClaimedBonuses: user.totalClaimedBonuses || 0
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// @route   GET /bonuses/active
// @desc    Get active/available bonuses including Promotional Campaigns
router.get('/active', verifyToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const now = new Date();

        const activeBonuses = [];

        // 1. Static Bonuses (Welcome, First Deposit)
        const staticBonusTypes = [
            { type: 'WELCOME_BONUS', title: 'Welcome Bonus', description: 'Get a bonus for joining ColorPool!' },
            { type: 'FIRST_DEPOSIT_BONUS', title: 'First Deposit Bonus', description: 'Bonus on your first successful deposit.' }
        ];

        for (const b of staticBonusTypes) {
            const claimed = await Bonus.findOne({ userId, bonusType: b.type, status: 'CLAIMED' });
            if (claimed) continue;

            const configKey = b.type.toLowerCase();
            const enabledConfig = await Config.findOne({ key: `${configKey}_enabled` });
            if (enabledConfig && enabledConfig.value === false) continue;

            const amountConfig = await Config.findOne({ key: configKey });
            const amount = amountConfig ? amountConfig.value : 0;

            activeBonuses.push({
                ...b,
                amount: amount / 100,
                status: 'AVAILABLE',
                claimMethod: 'AUTO'
            });
        }

        // 2. Referral Rewards Integration
        const pendingRefs = await ReferralHistory.find({ referrerId: userId, qualified: true, rewardPaid: false });
        if (pendingRefs.length > 0) {
            const refConfig = await Config.findOne({ key: 'referral_reward_amount' });
            const refAmount = refConfig ? refConfig.value : 100000;

            activeBonuses.push({
                type: 'REFERRAL_REWARD',
                title: 'Referral Rewards',
                description: `You have ${pendingRefs.length} qualified referral reward(s) pending.`,
                amount: (refAmount * pendingRefs.length) / 100,
                status: 'AVAILABLE',
                claimMethod: 'AUTO'
            });
        }

        // 3. Promotional Campaigns Integration (Phase 6)
        const campaigns = await Campaign.find({
            status: 'ACTIVE',
            isActive: true,
            startDate: { $lte: now },
            endDate: { $gte: now }
        }).sort({ priority: -1 });

        for (const campaign of campaigns) {
            const isEligible = await checkEligibility(userId, campaign);
            if (isEligible) {
                activeBonuses.push({
                    id: campaign._id,
                    campaignId: campaign.campaignId,
                    type: 'CAMPAIGN_REWARD',
                    title: campaign.name,
                    description: campaign.description,
                    amount: campaign.rewardAmount / 100,
                    status: 'AVAILABLE',
                    bannerUrl: campaign.bannerUrl,
                    claimMethod: campaign.claimMethod,
                    endDate: campaign.endDate
                });
            }
        }

        res.json({ success: true, data: activeBonuses });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// @route   GET /bonuses/conversion-status
// @desc    Get progress of bonuses being converted
router.get('/conversion-status', verifyToken, async (req, res) => {
    try {
        const bonuses = await Bonus.find({
            userId: req.user.uid,
            status: 'CLAIMED',
            conversionStatus: { $in: ['LOCKED', 'IN_PROGRESS', 'READY_TO_CONVERT'] }
        }).sort({ createdAt: -1 });

        res.json({
            success: true,
            data: bonuses.map(b => ({
                id: b._id,
                title: b.title,
                amount: b.amount / 100,
                status: b.conversionStatus,
                progress: {
                    wageringRequired: b.wageringRequired / 100,
                    wageringAchieved: b.wageringAchieved / 100,
                    percent: b.wageringRequired > 0 ? Math.min(100, (b.wageringAchieved / b.wageringRequired) * 100) : 100,
                    roundsRequired: b.roundsRequired,
                    roundsPlayed: b.roundsPlayed
                }
            }))
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// @route   POST /bonuses/convert/:bonusId
// @desc    Convert a READY_TO_CONVERT bonus to Main Wallet
router.post('/convert/:bonusId', verifyToken, async (req, res) => {
    try {
        const result = await convertBonusToMain(req.io, req.user.uid, req.params.bonusId);
        res.json(result);
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// @route   GET /bonuses/withdrawal-eligibility
// @desc    Check if user is eligible to withdraw
router.get('/withdrawal-eligibility', verifyToken, async (req, res) => {
    try {
        const result = await checkWithdrawalEligibility(req.user.uid);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// @route   GET /bonuses/history
// @desc    Get bonus claim and conversion history
router.get('/history', verifyToken, async (req, res) => {
    try {
        const userId = req.user.uid;

        // Fetch standard bonuses
        const standardBonuses = await Bonus.find({ userId, status: 'CLAIMED' }).sort({ claimedAt: -1 });

        // Fetch referral rewards to merge into history
        const refRewards = await ReferralTransaction.find({ userId }).sort({ createdAt: -1 });

        const history = [
            ...standardBonuses.map(h => ({
                id: h._id,
                bonusType: h.bonusType,
                title: h.title,
                amount: h.amount / 100,
                status: h.status,
                conversionStatus: h.conversionStatus,
                claimedAt: h.claimedAt,
                convertedAt: h.convertedAt,
                transactionReference: h.transactionReference || h.conversionReference
            })),
            ...refRewards.map(r => ({
                id: r._id,
                bonusType: 'REFERRAL_REWARD',
                title: 'Referral Reward',
                amount: r.amount / 100,
                status: 'CLAIMED',
                claimedAt: r.paidAt || r.createdAt,
                transactionReference: `REF-${r._id.toString().substr(-6).toUpperCase()}`,
                description: `Referral reward for ${r.referredUsername || 'a user'}`
            }))
        ];

        // Sort unified history by date descending
        history.sort((a, b) => new Date(b.claimedAt) - new Date(a.claimedAt));

        res.json({ success: true, data: history });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// @route   GET /bonuses/coming-soon
// @desc    Get coming soon bonuses
router.get('/coming-soon', verifyToken, async (req, res) => {
    try {
        const comingSoon = [
            { type: 'BIRTHDAY_BONUS', title: 'Birthday Bonus', description: 'A special gift on your birthday.', status: 'COMING_SOON' },
            { type: 'SEASONAL_BONUS', title: 'Seasonal Bonus', description: 'Rewards during holidays and events.', status: 'COMING_SOON' },
            { type: 'DAILY_STREAK', title: 'Daily Streak', description: 'Bonus for playing multiple days in a row.', status: 'COMING_SOON' },
            { type: 'PROMOTIONAL_BONUS', title: 'Promotional Bonus', description: 'Limited time offers and campaigns.', status: 'COMING_SOON' }
        ];
        res.json({ success: true, data: comingSoon });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
