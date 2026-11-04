const { User, Bonus, Config, Campaign } = require('../models');
const { createNotification } = require('./notificationHelper');
const mongoose = require('mongoose');

/**
 * Universal Bonus Awarding Engine
 *
 * @param {Object} io - Socket.io instance
 * @param {string} userId - Target user
 * @param {string} bonusType - Type of bonus (WELCOME_BONUS, FIRST_DEPOSIT_BONUS, etc.)
 * @param {Object} [providedSession] - Optional Mongoose session
 * @param {string} [campaignId] - Optional campaign ID if linked to a promotional campaign
 */
const awardBonus = async (io, userId, bonusType, providedSession = null, campaignId = null) => {
    const session = providedSession || await mongoose.startSession();
    const runInInternalTransaction = !providedSession;

    try {
        const logic = async (sess) => {
            // 1. Check if user already claimed this specific bonus type (Idempotency)
            // For campaigns, we check campaignId + userId. For static types, we check bonusType.
            const query = campaignId
                ? { userId, campaignId, status: 'CLAIMED' }
                : { userId, bonusType, status: 'CLAIMED' };

            const existing = await Bonus.findOne(query).session(sess);
            if (existing && bonusType !== 'REFERRAL_REWARD') return; // Allow multiple referral rewards

            // 2. Fetch configuration for this bonus
            let amount = 0;
            let wageringMultiplier = 0;
            let minRounds = 0;
            let expiryDays = 30;

            if (campaignId) {
                const campaign = await Campaign.findOne({ campaignId }).session(sess);
                if (campaign) {
                    amount = campaign.rewardAmount;
                    wageringMultiplier = campaign.conversionRules?.wageringMultiplier || 0;
                    minRounds = campaign.conversionRules?.minRounds || 0;
                    expiryDays = campaign.conversionRules?.expiryDays || 30;
                }
            } else {
                const configKey = bonusType.toLowerCase();
                // Check if bonus is enabled
                const enabledConfig = await Config.findOne({ key: `${configKey}_enabled` }).session(sess);
                if (enabledConfig && enabledConfig.value === false) return;

                const amountConfig = await Config.findOne({ key: configKey }).session(sess);
                amount = amountConfig ? amountConfig.value : (bonusType === 'WELCOME_BONUS' ? 100000 : 500000);

                // Fetch conversion rules from config if not campaign-based
                const multConfig = await Config.findOne({ key: `${configKey}_wagering_multiplier` }).session(sess);
                wageringMultiplier = multConfig ? multConfig.value : 3; // Default 3x if not set

                const roundsConfig = await Config.findOne({ key: `${configKey}_min_rounds` }).session(sess);
                minRounds = roundsConfig ? roundsConfig.value : 5; // Default 5 rounds
            }

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

            // 4. Create Bonus record with conversion requirements
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + expiryDays);

            const wageringRequired = amount * wageringMultiplier;

            await Bonus.create([{
                userId,
                bonusType,
                campaignId,
                title,
                description: `Received ${title} of ₦${(amount / 100).toLocaleString()}`,
                amount,
                status: 'CLAIMED',
                conversionStatus: wageringRequired > 0 || minRounds > 0 ? 'LOCKED' : 'READY_TO_CONVERT',
                wageringRequired,
                wageringAchieved: 0,
                roundsRequired: minRounds,
                roundsPlayed: 0,
                claimedAt: new Date(),
                expiresAt,
                transactionReference: `BN-${Date.now()}-${Math.floor(Math.random() * 1000)}`
            }], { session: sess });

            // 5. Notify User
            createNotification(io, {
                uid: userId,
                title: `${title} Received! 🎁`,
                body: `Congratulations! Your bonus of ₦${(amount / 100).toLocaleString()} has been added to your Bonus Wallet. Complete the wagering requirements to convert it to your Main Wallet.`,
                type: 'bonus',
                priority: 'high',
                category: 'promo',
                icon: 'card_giftcard',
                idempotencyKey: `bonus_${bonusType}_${campaignId || ''}_${userId}_${Date.now()}`
            });

            // Emit balance update specifically for bonus wallet
            io.to(userId).emit('bonus_update', {
                bonusWallet: user.bonusWallet / 100,
                totalBonusEarned: user.totalBonusEarned / 100
            });

            console.log(`🎁 Bonus awarded: ${bonusType} to ${userId} - ₦${amount/100} (Req: ${wageringMultiplier}x)`);
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
