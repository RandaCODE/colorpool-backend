const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const { User, ReferralHistory, ReferralTransaction, Config } = require('../models');
const { createNotification } = require('../utils/notificationHelper');

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

// @route   POST /referral/validate
// @desc    Validate a referral code
router.post('/validate', verifyToken, async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) return res.status(400).json({ success: false, error: 'Referral code is required' });

        const referrer = await User.findOne({ referralCode: code.toUpperCase() });
        if (!referrer) return res.status(404).json({ success: false, error: 'Invalid referral code' });

        if (referrer.userId === req.user.uid) {
            return res.status(400).json({ success: false, error: 'You cannot refer yourself' });
        }

        res.json({ success: true, message: 'Valid referral code', referrerName: referrer.email.split('@')[0] });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// @route   GET /referral/stats
// @desc    Get referral statistics for current user
router.get('/stats', verifyToken, async (req, res) => {
    try {
        const user = await User.findOne({ userId: req.user.uid });
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });

        const rewardConfig = await Config.findOne({ key: 'referral_reward_amount' });
        const standardReward = rewardConfig ? rewardConfig.value : 100000;

        // Pending rewards: Referrals that have not been paid yet
        const referrals = await ReferralHistory.find({ referrerId: req.user.uid });
        const unpaidCount = referrals.filter(r => !r.rewardPaid).length;
        const pendingRewardKobo = unpaidCount * standardReward;

        res.json({
            success: true,
            data: {
                referralCode: user.referralCode,
                referralLink: `https://colorpool.app/ref/${user.referralCode}`,
                totalReferrals: user.totalReferrals,
                pendingReferrals: user.pendingReferrals,
                qualifiedReferrals: user.qualifiedReferrals,
                referralWallet: user.referralWallet / 100,
                lifetimeRewards: user.totalReferralEarnings / 100,
                pendingRewards: pendingRewardKobo / 100,
                paidRewards: (user.totalReferralEarnings || 0) / 100
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// @route   GET /referral/history
// @desc    Get referral history (the users referred)
router.get('/history', verifyToken, async (req, res) => {
    try {
        const history = await ReferralHistory.find({ referrerId: req.user.uid }).sort({ createdAt: -1 });
        res.json({
            success: true,
            data: history.map(h => ({
                id: h._id,
                username: h.referredUsername,
                status: h.status,
                qualified: h.qualified,
                rewardPaid: h.rewardPaid,
                rewardAmount: h.rewardAmount / 100,
                createdAt: h.createdAt,
                paidAt: h.rewardPaidAt
            }))
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// @route   GET /referral/transactions
// @desc    Get referral reward transaction history
router.get('/transactions', verifyToken, async (req, res) => {
    try {
        const transactions = await ReferralTransaction.find({ userId: req.user.uid }).sort({ createdAt: -1 });
        res.json({
            success: true,
            data: transactions.map(tx => ({
                id: tx._id,
                referredUsername: tx.referredUsername,
                amount: tx.amount / 100,
                status: tx.status,
                reason: tx.reason,
                paidAt: tx.paidAt,
                createdAt: tx.createdAt
            }))
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
