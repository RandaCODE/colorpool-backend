const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const auth = require('../middleware/auth');

// @route   GET /admin/auth/me
// @desc    Get current admin info (reads Firestore collection 'admins')
router.get('/me', auth, async (req, res) => {
    try {
        const db = admin.firestore();
        const adminDoc = await db.collection('admins').doc(req.admin.id).get();

        if (!adminDoc.exists) {
            return res.status(404).json({ msg: 'Admin profile not found in Firestore' });
        }

        res.json({
            ...adminDoc.data(),
            uid: req.admin.id
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

module.exports = router;
