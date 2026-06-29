const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Bet = require('../models/Bet');
const Round = require('../models/Round');

// @route   GET /admin/dashboard/stats
router.get('/stats', auth, async (req, res) => {
    try {
        const totalUsers = await User.countDocuments();

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

        const pendingLiabilitiesAgg = await Transaction.aggregate([
            { $match: { type: 'withdrawal', status: { $in: ['pending', 'approved'] } } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const pendingWinningLiabilities = pendingLiabilitiesAgg.length > 0 ? pendingLiabilitiesAgg[0].total : 0;

        const platformReserve = totalDeposits - totalWithdrawals - pendingWinningLiabilities;

        const bets = await Bet.aggregate([
            { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
        ]);
        const totalBetsAmount = bets.length > 0 ? bets[0].total : 0;
        const totalBetsCount = bets.length > 0 ? bets[0].count : 0;

        const wins = await Bet.aggregate([
            { $match: { status: 'won' } },
            { $group: { _id: null, total: { $sum: '$payout' } } }
        ]);
        const totalWinsPaid = wins.length > 0 ? wins[0].total : 0;

        const totalRevenue = totalBetsAmount - totalWinsPaid;

        const pendingWithdrawalsCount = await Transaction.countDocuments({ type: 'withdrawal', status: 'pending' });
        const activePlayers = await User.countDocuments({ accountStatus: 'active' });

        // Today's Stats
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        const todayRevenueAgg = await Bet.aggregate([
            { $match: { createdAt: { $gte: startOfToday } } },
            { $group: {
                _id: null,
                staked: { $sum: '$amount' },
                payout: { $sum: { $cond: [{ $eq: ["$status", "won"]}, "$payout", 0] } }
            } }
        ]);
        const todayRevenue = todayRevenueAgg.length > 0 ? (todayRevenueAgg[0].staked - todayRevenueAgg[0].payout) : 0;

        // Monthly Revenue
        const startOfMonth = new Date();
        startOfMonth.setDate(1);
        startOfMonth.setHours(0, 0, 0, 0);

        const monthRevenueAgg = await Bet.aggregate([
            { $match: { createdAt: { $gte: startOfMonth } } },
            { $group: {
                _id: null,
                staked: { $sum: '$amount' },
                payout: { $sum: { $cond: [{ $eq: ["$status", "won"]}, "$payout", 0] } }
            } }
        ]);
        const monthlyRevenue = monthRevenueAgg.length > 0 ? (monthRevenueAgg[0].staked - monthRevenueAgg[0].payout) : 0;

        res.json({
            totalUsers,
            totalDeposits,
            totalWithdrawals,
            pendingWinningLiabilities,
            totalBetsCount,
            totalBetsAmount,
            totalWinsPaid,
            totalRevenue,
            platformReserve,
            pendingWithdrawals: pendingWithdrawalsCount,
            activePlayers,
            todayRevenue,
            monthlyRevenue
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   GET /admin/dashboard/liquidity
router.get('/liquidity', auth, async (req, res) => {
    try {
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

        const pendingLiabilitiesAgg = await Transaction.aggregate([
            { $match: { type: 'withdrawal', status: { $in: ['pending', 'approved'] } } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const pendingWinningLiabilities = pendingLiabilitiesAgg.length > 0 ? pendingLiabilitiesAgg[0].total : 0;

        // Formula: Platform Reserve = Successful Deposits - Successful Withdrawals - Pending Winning Liabilities
        const platformReserve = totalDeposits - totalWithdrawals - pendingWinningLiabilities;

        const wallets = await User.aggregate([
            { $group: { _id: null, total: { $sum: '$walletBalance' } } }
        ]);
        const totalLiability = wallets.length > 0 ? wallets[0].total : 0;

        // Formula: Coverage Ratio = Reserve / Total User Liabilities
        const coveragePercentage = totalLiability > 0 ? (platformReserve / totalLiability) * 100 : 100;

        let status = 'SAFE';
        if (coveragePercentage < 80) status = 'DANGER';
        else if (coveragePercentage < 120) status = 'WARNING';

        res.json({
            totalDeposits,
            totalWithdrawals,
            pendingWinningLiabilities,
            platformReserve,
            totalLiability,
            coveragePercentage,
            status,
            canWithdraw: status !== 'DANGER'
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

module.exports = router;
