const { User, Bonus, Config } = require('../models');
const { createNotification } = require('./notificationHelper');
const mongoose = require('mongoose');

/**
 * Universal Bonus Awarding Engine
 *
 * @param {Object} io - Socket.io instance
 * @param {string} userId - Target user
 * @param {string} bonusType - Type of bonus (WELCOME_BONUS, FIRST_DEPOSIT_BONUS, etc.)
 * @param {Object} [providedSession] - Optional Mongoose session
 */
const awardBonus = async (io, userId, bonusType, providedSession = null) => {
    const session = providedSession || await mongoose.startSession();
    const runInInternalTransaction = !providedSession;

    try {
        const logic = async (sess) => {
            // 1. Check if user already claimed this specific bonus type (Idempotency)
            const existing = await Bonus.findOne({ userId, bonusType, status: 'CLAIMED' }).session(sess);
            if (existing) return;

            // 2. Fetch configuration for this bonus
            const configKey = bonusType.toLowerCase();
            const config = await Config.findOne({ key: configKey }).session(sess);

            // Check if bonus is enabled
            const enabledConfig = await Config.findOne({ key: `${configKey}_enabled` }).session(sess);
            if (enabledConfig && enabledConfig.value === false) return;

            const amount = config ? config.value : (bonusType === 'WELCOME_BONUS' ? 100000 : 500000); // Defaults
            const title = bonusType.split('_').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');

            // 3. Update User's Bonus Wallet
            const user = await User.findOneAndUpdate(
                { userId },
                {
                    $inc: {
                        bonusWallet: amount,
                        totalBonusEarned: amount,
                        totalClaimedBonuses: 1
                    }
                },
                { session: sess, new: true }
            );

            if (!user) throw new Error("User not found");

            // 4. Create Bonus History record
            const bonusRecord = await Bonus.create([{
                userId,
                bonusType,
                title,
                description: `Received ${title} of ₦${(amount / 100).toLocaleString()}`,
                amount,
                status: 'CLAIMED',
                claimedAt: new Date(),
                transactionReference: `BN-${Date.now()}-${Math.floor(Math.random() * 1000)}`
            }], { session: sess });

            // 5. Notify User
            createNotification(io, {
                uid: userId,
                title: `${title} Received! 🎁`,
                body: `Congratulations! Your bonus of ₦${(amount / 100).toLocaleString()} has been added to your Bonus Wallet.`,
                type: 'bonus',
                priority: 'high',
                category: 'promo',
                icon: 'card_giftcard',
                idempotencyKey: `bonus_${bonusType}_${userId}`
            });

            // Emit balance update specifically for bonus wallet if needed
            io.to(userId).emit('bonus_update', {
                bonusWallet: user.bonusWallet / 100,
                totalBonusEarned: user.totalBonusEarned / 100
            });

            console.log(`🎁 Bonus awarded: ${bonusType} to ${userId} - ₦${amount/100}`);
        };

        if (runInInternalTransaction) {
            await session.withTransaction(() => logic(session));
        } else {
            await logic(session);
        }
    } catch (error) {
        console.error(`❌ Error awarding ${bonusType} for ${userId}:`, error.message);
        if (runInInternalTransaction) throw error;
    } finally {
        if (runInInternalTransaction) session.endSession();
    }
};

module.exports = { awardBonus };
