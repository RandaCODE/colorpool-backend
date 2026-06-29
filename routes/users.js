const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const User = require('../models/User');

// Middleware to check if user has admin/super_admin permissions
const canViewUsers = (req, res, next) => {
    if (req.admin.role === 'super_admin' || req.admin.role === 'admin') {
        next();
    } else {
        res.status(403).json({ msg: 'Access denied: Admin permissions required' });
    }
};

const canManageUsers = (req, res, next) => {
    if (req.admin.role === 'super_admin') {
        next();
    } else {
        res.status(403).json({ msg: 'Access denied: Super Admin permissions required' });
    }
};

const canManageWallets = (req, res, next) => {
    if (req.admin.role === 'super_admin' || req.admin.role === 'finance_admin') {
        next();
    } else {
        res.status(403).json({ msg: 'Access denied: Finance/Super Admin permissions required' });
    }
};

// @route   GET /admin/users
router.get('/', auth, canViewUsers, async (req, res) => {
    try {
        const users = await User.find().sort({ createdAt: -1 });
        res.json(users);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   GET /admin/users/:id
router.get('/:id', auth, canViewUsers, async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ msg: 'User not found' });
        res.json(user);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   PUT /admin/users/:id/status
router.put('/:id/status', auth, canManageUsers, async (req, res) => {
    const { status } = req.body;
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ msg: 'User not found' });

        user.accountStatus = status;
        await user.save();
        res.json(user);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   PUT /admin/users/:id/wallet
router.put('/:id/wallet', auth, canManageWallets, async (req, res) => {
    const { amount, action } = req.body; // action: 'add' or 'deduct'
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ msg: 'User not found' });

        if (action === 'add') {
            user.walletBalance += amount;
        } else if (action === 'deduct') {
            user.walletBalance -= amount;
        }

        await user.save();
        res.json(user);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

module.exports = router;
