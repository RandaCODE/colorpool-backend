const { User, Bonus, Campaign, Config, Transaction } = require('../models');
const { createNotification } = require('./notificationHelper');
const mongoose = require('mongoose');

/**
 * Updates bonus wagering progress for a user after a bet is settled.
 *
 * @param {Object} io - Socket.io instance
 * @param {string} userId - Target user
 * @param {number} betAmount - Amount wagered in Kobo
 * @param {Object} [session] - Optional Mongoose session
 */
const updateBonusProgress = async (io, userId, betAmount, session = null) => {
    try {
        const now = new Date();

        // Find all bonuses currently in progress or locked for this user that haven't expired
        const activeBonuses = await Bonus.find({
            userId,
            status: 'CLAIMED',
            conversionStatus: { $in: ['LOCKED', 'IN_PROGRESS'] },
            expiresAt: { $gt: now }
        }).session(session);

        for (const bonus of activeBonuses) {
            // Update progress
            bonus.wageringAchieved += betAmount;
            bonus.roundsPlayed += 1;

            if (bonus.conversionStatus === 'LOCKED') {
                bonus.conversionStatus = 'IN_PROGRESS';
            }

            // Check if requirements met
            const wageringMet = bonus.wageringAchieved >= bonus.wageringRequired;
            const roundsMet = bonus.roundsPlayed >= bonus.roundsRequired;

            if (wageringMet && roundsMet) {
                bonus.conversionStatus = 'READY_TO_CONVERT';

                // Notify user
                createNotification(io, {
                    uid: userId,
                    title: 'Bonus Ready to Convert! 🎊',
                    body: `Requirements for ${bonus.title} are completed. You can now convert it to your Main Wallet.`,
                    type: 'bonus',
                    priority: 'high',
                    route: '/bonus_center',
                    category: 'promo',
                    icon: 'auto_fix_high',
                    idempotencyKey: `ready_conv_${bonus._id}`
                });

                io.to(userId).emit('bonus_ready_to_convert', { bonusId: bonus._id, title: bonus.title });

                // Check for Automatic Conversion if enabled in config
                const autoConvertConfig = await Config.findOne({ key: 'auto_convert_bonuses' }).session(session);
                if (autoConvertConfig && autoConvertConfig.value === true) {
                    // Note: Performing conversion here might be complex due to wallet updates
                    // and transaction history inside a loop. Manual is default and safer.
                    // If auto-convert is strictly required, we'd trigger it here.
                }
            }

            await bonus.save({ session });
        }

        // Update user's lifetime stats and global wager volume
        await User.findOneAndUpdate(
            { userId },
            { $inc: { totalWagered: betAmount } },
            { session }
        );

    } catch (error) {
        console.error(`❌ Error updating bonus progress for ${userId}:`, error.message);
    }
};

/**
 * Validates if a user is eligible to withdraw.
 */
const checkWithdrawalEligibility = async (userId) => {
    try {
        const user = await User.findOne({ userId });
        if (!user) return { eligible: false, status: 'NOT_ELIGIBLE', reason: 'User not found' };

        // 1. Account & Security Checks
        if (user.isFlagged) return { eligible: false, status: 'LOCKED', reason: 'Account flagged for review' };
        if (user.kycStatus !== 'verified') return { eligible: false, status: 'PENDING_VERIFICATION', reason: 'KYC verification required' };
        if (user.isWithdrawalRestricted) return { eligible: false, status: 'LOCKED', reason: user.withdrawalRestrictionReason || 'Withdrawal restricted' };

        // 2. Active Bonus Constraints
        const lockedBonuses = await Bonus.find({
            userId,
            status: 'CLAIMED',
            conversionStatus: { $in: ['LOCKED', 'IN_PROGRESS'] },
            expiresAt: { $gt: new Date() }
        });

        const restrictionConfig = await Config.findOne({ key: 'restrict_withdrawal_with_active_bonus' });
        const isRestrictedByActiveBonus = restrictionConfig ? restrictionConfig.value === true : false;

        if (isRestrictedByActiveBonus && lockedBonuses.length > 0) {
            return {
                eligible: false,
                status: 'LOCKED',
                reason: 'Active bonuses must be completed or converted before withdrawal.',
                details: { activeBonuses: lockedBonuses.length }
            };
        }

        // 3. AML / Wagering Integrity (Minimum turnover)
        const minTurnoverMult = await Config.findOne({ key: 'min_deposit_wager_multiplier' });
        const requiredTurnover = user.totalDeposited * (minTurnoverMult ? minTurnoverMult.value : 1);

        if (user.totalWagered < requiredTurnover) {
            return {
                eligible: false,
                status: 'NOT_ELIGIBLE',
                reason: `Minimum wagering not met. You must wager at least ₦${(requiredTurnover / 100).toLocaleString()} before withdrawing.`,
                details: { achieved: user.totalWagered / 100, required: requiredTurnover / 100 }
            };
        }

        return { eligible: true, status: 'ELIGIBLE', reason: 'Eligible for withdrawal' };
    } catch (error) {
        return { eligible: false, status: 'NOT_ELIGIBLE', reason: 'Eligibility check failed' };
    }
};

/**
 * Converts a "READY_TO_CONVERT" bonus to the Main Wallet.
 */
const convertBonusToMain = async (io, userId, bonusId, isAdmin = false, adminUid = null) => {
    const session = await mongoose.startSession();
    try {
        let result = null;
        await session.withTransaction(async () => {
            const bonus = await Bonus.findOne({ _id: bonusId, userId, conversionStatus: 'READY_TO_CONVERT' }).session(session);
            if (!bonus) throw new Error('Bonus not ready for conversion');

            const conversionAmount = bonus.amount;

            // Atomic wallet transfer
            const user = await User.findOneAndUpdate(
                { userId, bonusWallet: { $gte: conversionAmount } },
                {
                    $inc: {
                        bonusWallet: -conversionAmount,
                        balance: conversionAmount
                    }
                },
                { session, new: true }
            );

            if (!user) throw new Error('Insufficient bonus wallet balance');

            // Update status
            bonus.conversionStatus = 'CONVERTED';
            bonus.convertedAt = new Date();
            bonus.conversionReference = `CONV-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            await bonus.save({ session });

            // Record transaction
            await Transaction.create([{
                userId,
                username: user.email.split('@')[0],
                type: 'bonus_conversion',
                amount: conversionAmount,
                balanceAfter: user.balance,
                description: `Converted ${bonus.title} to Main Wallet`,
                status: 'success',
                reference: bonus.conversionReference,
                processedBy: isAdmin ? adminUid : 'SYSTEM'
            }], { session });

            // Notify User
            createNotification(io, {
                uid: userId,
                title: 'Bonus Converted! 💰',
                body: `₦${(conversionAmount / 100).toLocaleString()} from ${bonus.title} has been moved to your Main Wallet.`,
                type: 'wallet',
                priority: 'high',
                category: 'finance',
                icon: 'account_balance_wallet',
                idempotencyKey: `conv_${bonusId}`
            });

            // Check if user BECOMES eligible for withdrawal after this conversion (if it was the last blocker)
            const eligibility = await checkWithdrawalEligibility(userId);
            if (eligibility.eligible) {
                createNotification(io, {
                    uid: userId,
                    title: 'Withdrawal Available! 🔓',
                    body: 'You are now eligible to withdraw your funds.',
                    type: 'withdrawal',
                    category: 'finance',
                    icon: 'lock_open',
                    idempotencyKey: `with_avail_${userId}_${bonusId}`
                });
            }

            io.to(userId).emit('balance_update', { balance: user.balance / 100 });
            io.to(userId).emit('bonus_update', { bonusWallet: user.bonusWallet / 100 });

            result = { success: true, amount: conversionAmount / 100 };
        });
        return result;
    } catch (error) {
        throw error;
    } finally {
        session.endSession();
    }
};

/**
 * Marks expired bonuses for a user.
 */
const expireBonuses = async (userId) => {
    try {
        await Bonus.updateMany(
            {
                userId,
                status: 'CLAIMED',
                conversionStatus: { $in: ['LOCKED', 'IN_PROGRESS', 'READY_TO_CONVERT'] },
                expiresAt: { $lt: new Date() }
            },
            { $set: { conversionStatus: 'EXPIRED' } }
        );
    } catch (e) { console.error("Error expiring bonuses:", e); }
};

module.exports = { updateBonusProgress, checkWithdrawalEligibility, convertBonusToMain, expireBonuses };
