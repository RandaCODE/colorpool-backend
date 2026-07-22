const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const { Campaign, Bonus, User } = require('../models');
const { checkEligibility, claimCampaignReward } = require('../utils/campaignProcessor');

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

async function verifyAdmin(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ success: false, error: 'Unauthorized' });
        const decodedToken = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
        const user = await User.findOne({ userId: decodedToken.uid });
        if (!user || !user.isAdmin) return res.status(403).json({ success: false, error: 'Forbidden' });
        req.user = decodedToken;
        next();
    } catch (error) { return res.status(401).json({ success: false, error: 'Invalid session' }); }
}

// @route   GET /campaigns/active
// @desc    Get active campaigns for the current user
router.get('/active', verifyToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const now = new Date();

        // Find all ACTIVE campaigns within date range
        const campaigns = await Campaign.find({
            status: 'ACTIVE',
            isActive: true,
            startDate: { $lte: now },
            endDate: { $gte: now }
        }).sort({ priority: -1 });

        const eligibleCampaigns = [];

        for (const campaign of campaigns) {
            const isEligible = await checkEligibility(userId, campaign);
            if (isEligible) {
                eligibleCampaigns.push(campaign);
            }
        }

        res.json({ success: true, data: eligibleCampaigns });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// @route   GET /campaigns/details/:campaignId
// @desc    Get details for a specific campaign
router.get('/details/:campaignId', verifyToken, async (req, res) => {
    try {
        const campaign = await Campaign.findOne({ campaignId: req.params.campaignId });
        if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });

        const isEligible = await checkEligibility(req.user.uid, campaign);

        res.json({
            success: true,
            data: {
                ...campaign.toObject(),
                isEligible
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// @route   POST /campaigns/claim/:campaignId
// @desc    Claim reward for a CLAIM_BUTTON campaign
router.post('/claim/:campaignId', verifyToken, async (req, res) => {
    try {
        const { campaignId } = req.params;
        const userId = req.user.uid;

        const campaign = await Campaign.findOne({ campaignId, status: 'ACTIVE', claimMethod: 'CLAIM_BUTTON' });
        if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found or not claimable manually' });

        await claimCampaignReward(req.io, userId, campaignId);

        res.json({ success: true, message: 'Reward claimed successfully' });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// @route   GET /campaigns/history
// @desc    Get user's campaign reward history
router.get('/history', verifyToken, async (req, res) => {
    try {
        const history = await Bonus.find({
            userId: req.user.uid,
            bonusType: 'CAMPAIGN_REWARD',
            status: 'CLAIMED'
        }).sort({ claimedAt: -1 });

        res.json({ success: true, data: history });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ADMIN ENDPOINTS (Skeleton for Phase 6 Deliverables)

router.post('/admin/create', verifyAdmin, async (req, res) => {
    try {
        const campaign = new Campaign(req.body);
        await campaign.save();
        res.json({ success: true, data: campaign });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

router.get('/admin/list', verifyAdmin, async (req, res) => {
    try {
        const campaigns = await Campaign.find().sort({ createdAt: -1 });
        res.json({ success: true, data: campaigns });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.patch('/admin/update/:campaignId', verifyAdmin, async (req, res) => {
    try {
        const campaign = await Campaign.findOneAndUpdate(
            { campaignId: req.params.campaignId },
            req.body,
            { new: true }
        );
        res.json({ success: true, data: campaign });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

module.exports = router;
