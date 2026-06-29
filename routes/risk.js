const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Bet = require('../models/Bet');
const Round = require('../models/Round');
const Transaction = require('../models/Transaction');

// Middleware to check if user has risk/admin permissions
const canViewRisk = (req, res, next) => {
    if (req.admin.role === 'super_admin' || req.admin.role === 'admin') {
        next();
    } else {
        res.status(403).json({ msg: 'Access denied: Admin permissions required' });
    }
};

// @route   GET /admin/risk/exposure
router.get('/exposure', auth, canViewRisk, async (req, res) => {
    try {
        const activeRound = await Round.findOne({ status: 'active' });
        if (!activeRound) return res.status(404).json({ msg: 'No active round found' });

        const bets = await Bet.find({ roundId: activeRound._id });

        const colors = ['green', 'blue', 'purple'];
        const exposure = {};

        colors.forEach(color => {
            const colorBets = bets.filter(b => b.color === color);
            const totalStaked = colorBets.reduce((sum, b) => sum + b.amount, 0);
            const multiplier = color === 'purple' ? 3 : 2;
            const potentialPayout = totalStaked * multiplier;

            exposure[color] = {
                count: colorBets.length,
                totalStaked,
                potentialPayout
            };
        });

        const deposits = await Transaction.aggregate([
            { $match: { type: 'deposit', status: 'approved' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const totalDeposits = deposits.length > 0 ? deposits[0].total : 0;
        const withdrawals = await Transaction.aggregate([
            { $match: { type: 'withdrawal', status: 'paid' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const totalWithdrawals = withdrawals.length > 0 ? withdrawals[0].total : 0;
        const platformReserve = totalDeposits - totalWithdrawals;

        const analysis = colors.map(color => {
            const payout = exposure[color].potentialPayout;
            const totalStakedInRound = bets.reduce((sum, b) => sum + b.amount, 0);
            const actualProfitIfWins = totalStakedInRound - payout;

            let status = 'SAFE';
            if (actualProfitIfWins < 0) {
                if (Math.abs(actualProfitIfWins) > platformReserve * 0.1) status = 'CRITICAL';
                else status = 'WARNING';
            }

            return {
                color,
                payout,
                platformReserve,
                netProfit: actualProfitIfWins,
                status,
                exposureLevel: actualProfitIfWins < 0 ? 'LOSS EXPOSURE' : 'PROFIT'
            };
        });

        res.json({
            roundId: activeRound._id,
            roundNumber: activeRound.roundNumber,
            exposure,
            analysis
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

module.exports = router;
