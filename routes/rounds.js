const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Round = require('../models/Round');
const Bet = require('../models/Bet');
const User = require('../models/User');
const GlobalState = require('../models/GlobalState');

// Middleware to check if user has admin permissions
const canViewRounds = (req, res, next) => {
    if (req.admin.role === 'super_admin' || req.admin.role === 'admin') {
        next();
    } else {
        res.status(403).json({ msg: 'Access denied: Admin permissions required' });
    }
};

const canManageRounds = (req, res, next) => {
    if (req.admin.role === 'super_admin') {
        next();
    } else {
        res.status(403).json({ msg: 'Access denied: Super Admin permissions required' });
    }
};

// @route   GET /admin/rounds/game-state
router.get('/game-state', auth, canViewRounds, async (req, res) => {
    try {
        let state = await GlobalState.findOne().populate('roundId');
        if (!state) {
            state = new GlobalState();
            await state.save();
        }
        res.json(state);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   POST /admin/rounds/force-winner
router.post('/force-winner', auth, canManageRounds, async (req, res) => {
    const { color } = req.body;
    try {
        let state = await GlobalState.findOne();
        if (!state) state = new GlobalState();

        state.forcedWinner = color;
        await state.save();

        res.json({ msg: `Forced winner set to ${color}`, state });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   POST /admin/rounds/start
router.post('/start', auth, canManageRounds, async (req, res) => {
    try {
        const roundNumber = `RN-${Date.now()}`;
        const newRound = new Round({ roundNumber });
        await newRound.save();

        // Update Global State
        let state = await GlobalState.findOne();
        if (!state) state = new GlobalState();

        state.roundId = newRound._id;
        state.status = 'betting';
        state.time = 30;
        state.bettingLocked = false;
        state.pools = { green: 0, purple: 0, blue: 0 };
        state.forcedWinner = null;
        await state.save();

        res.json(newRound);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   PUT /admin/rounds/:id/end
router.put('/:id/end', auth, canManageRounds, async (req, res) => {
    const { winningColor } = req.body;
    try {
        const round = await Round.findById(req.params.id);
        if (!round) return res.status(404).json({ msg: 'Round not found' });

        const state = await GlobalState.findOne();
        const finalWinner = state?.forcedWinner || winningColor;

        round.status = 'ended';
        round.winningColor = finalWinner;
        round.endTime = Date.now();
        await round.save();

        // Process Bets
        const bets = await Bet.find({ roundId: round._id });
        let totalPayout = 0;

        for (let bet of bets) {
            if (bet.color === finalWinner) {
                const multiplier = finalWinner === 'purple' ? 3 : 2;
                bet.payout = bet.amount * multiplier;
                bet.status = 'won';

                await User.findByIdAndUpdate(bet.userId, { $inc: { walletBalance: bet.payout } });
                totalPayout += bet.payout;
            } else {
                bet.status = 'lost';
            }
            await bet.save();
        }

        round.totalPayout = totalPayout;
        await round.save();

        // Reset Global State for next round wait
        if (state) {
            state.status = 'ended';
            state.forcedWinner = null; // Clear forced winner after settlement
            await state.save();
        }

        res.json(round);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

module.exports = router;
