const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const { User, Bonus, ReferralHistory, ReferralTransaction, Config } = require('../models');

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
// @desc    Get active/available bonuses
router.get('/active', verifyToken, async (req, res) => {
    try {
        const userId = req.user.uid;

        const bonusTypes = [
            { type: 'WELCOME_BONUS', title: 'Welcome Bonus', description: 'Get a bonus for joining ColorPool!' },
            { type: 'FIRST_DEPOSIT_BONUS', title: 'First Deposit Bonus', description: 'Bonus on your first successful deposit.' }
        ];

        const activeBonuses = [];

        for (const b of bonusTypes) {
            // Check if already claimed
            const claimed = await Bonus.findOne({ userId, bonusType: b.type, status: 'CLAIMED' });
            if (claimed) continue;

            // Check if enabled in config
            const configKey = b.type.toLowerCase();
            const enabledConfig = await Config.findOne({ key: `${configKey}_enabled` });
            if (enabledConfig && enabledConfig.value === false) continue;

            const amountConfig = await Config.findOne({ key: configKey });
            const amount = amountConfig ? amountConfig.value : 0;

            activeBonuses.push({
                ...b,
                amount: amount / 100,
                status: 'AVAILABLE'
            });
        }

        // Referral Rewards Integration
        const pendingRefs = await ReferralHistory.find({ referrerId: userId, qualified: true, rewardPaid: false });
        if (pendingRefs.length > 0) {
            const refConfig = await Config.findOne({ key: 'referral_reward_amount' });
            const refAmount = refConfig ? refConfig.value : 100000;

            activeBonuses.push({
                type: 'REFERRAL_REWARD',
                title: 'Referral Rewards',
                description: `You have ${pendingRefs.length} qualified referral reward(s) pending.`,
                amount: (refAmount * pendingRefs.length) / 100,
                status: 'AVAILABLE'
            });
        }

        res.json({ success: true, data: activeBonuses });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// @route   GET /bonuses/history
// @desc    Get bonus claim history (Unified Bonus History)
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
                claimedAt: h.claimedAt,
                transactionReference: h.transactionReference
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
