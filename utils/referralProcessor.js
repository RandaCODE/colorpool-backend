const { User, ReferralHistory, ReferralTransaction, Config } = require('../models');
const { createNotification } = require('./notificationHelper');
const mongoose = require('mongoose');

/**
 * Processes the referral reward for a qualified referral.
 * Implements strict idempotency to prevent double payments.
 *
 * Objectives:
 * When qualified == true && rewardPending == true && rewardPaid == false:
 * - Credit Referral Wallet
 * - Update status to REWARD_PAID
 * - Update rewardPending = false, rewardPaid = true, rewardPaidAt = current timestamp
 *
 * @param {Object} io - Socket.io instance
 * @param {string} referredUserId - The user who was referred
 * @param {Object} [providedSession] - Optional Mongoose session for transaction sharing
 */
const processReferralReward = async (io, referredUserId, providedSession = null) => {
    const session = providedSession || await mongoose.startSession();
    const runInInternalTransaction = !providedSession;

    try {
        const logic = async (sess) => {
            // 1. Fetch referral record with lock and strict qualification check
            const referral = await ReferralHistory.findOne({
                referredUserId,
                qualified: true,
                rewardPending: true,
                rewardPaid: false
            }).session(sess);

            if (!referral) return;

            // 2. Fetch reward amount from config
            const rewardConfig = await Config.findOne({ key: 'referral_reward_amount' }).session(sess);
            const rewardAmount = rewardConfig ? rewardConfig.value : 100000; // Default ₦1,000

            const referrerId = referral.referrerId;

            // 3. Update Referrer's Referral Wallet (Separated from main wallet)
            const referrer = await User.findOneAndUpdate(
                { userId: referrerId },
                {
                    $inc: {
                        referralWallet: rewardAmount,
                        totalReferralEarnings: rewardAmount
                    }
                },
                { session: sess, new: true }
            );

            if (!referrer) throw new Error("Referrer user not found");

            // 4. Create Referral Transaction record (Dedicated History)
            await ReferralTransaction.create([{
                userId: referrerId,
                referredUserId: referredUserId,
                referredUsername: referral.referredUsername,
                amount: rewardAmount,
                status: 'success',
                reason: 'Referral Reward',
                paidAt: new Date()
            }], { session: sess });

            // 5. Update Referral History record (Idempotency check passed above)
            referral.status = 'REWARD_PAID';
            referral.rewardPending = false;
            referral.rewardPaid = true;
            referral.rewardAmount = rewardAmount;
            referral.rewardPaidAt = new Date();
            await referral.save({ session: sess });

            // 6. Notify Referrer (Reuse existing notification system)
            createNotification(io, {
                uid: referrerId,
                title: 'Referral Reward Received',
                body: `Your referral reward of ₦${(rewardAmount / 100).toLocaleString()} has been credited to your Referral Wallet.`,
                type: 'referral',
                priority: 'high',
                category: 'finance',
                icon: 'payments',
                idempotencyKey: `ref_pay_${referredUserId}`
            });

            console.log(`✅ Referral reward of ₦${rewardAmount/100} paid to ${referrerId} for referring ${referredUserId}`);
        };

        if (runInInternalTransaction) {
            await session.withTransaction(() => logic(session));
        } else {
            await logic(session);
        }
    } catch (error) {
        console.error(`❌ Error processing referral reward for ${referredUserId}:`, error.message);
        if (runInInternalTransaction) throw error;
    } finally {
        if (runInInternalTransaction) session.endSession();
    }
};

module.exports = { processReferralReward };
