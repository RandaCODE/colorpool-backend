const { Campaign, Bonus, User } = require('../models');
const mongoose = require('mongoose');

/**
 * Checks if a user is eligible for a specific campaign.
 * Handles standard rules, Birthday logic, and Seasonal windows.
 *
 * @param {string} userId - The user ID to check
 * @param {Object} campaign - The campaign object from database
 * @returns {Promise<boolean>} - True if eligible
 */
const checkEligibility = async (userId, campaign) => {
    try {
        if (campaign.status !== 'ACTIVE') return false;

        const now = new Date();
        if (now < campaign.startDate || now > campaign.endDate) return false;

        if (campaign.maxClaims > 0 && campaign.currentClaims >= campaign.maxClaims) return false;

        const user = await User.findOne({ userId });
        if (!user) return false;

        const rules = campaign.eligibilityRules;

        // 1. KYC Verification Requirement
        if (rules.accountVerified && user.kycStatus !== 'verified') return false;

        // 2. Birthday Specific Logic
        if (campaign.type === 'BIRTHDAY') {
            if (!user.dob) return false;

            const userDob = new Date(user.dob);
            const currentYear = now.getFullYear();

            // User's birthday in the current year
            const thisYearBirthday = new Date(currentYear, userDob.getMonth(), userDob.getDate());

            // Check claim window (days before/after birthday)
            const windowDays = rules.birthdayClaimWindow || 0;
            const windowStart = new Date(thisYearBirthday);
            windowStart.setDate(thisYearBirthday.getDate() - windowDays);

            const windowEnd = new Date(thisYearBirthday);
            windowEnd.setDate(thisYearBirthday.getDate() + windowDays);

            if (now < windowStart || now > windowEnd) return false;

            // Ensure only one birthday bonus per calendar year
            const startOfYear = new Date(currentYear, 0, 1);
            const endOfYear = new Date(currentYear, 11, 31, 23, 59, 59);

            const existingYearlyClaim = await Bonus.findOne({
                userId,
                bonusType: 'BIRTHDAY_BONUS',
                status: 'CLAIMED',
                claimedAt: { $gte: startOfYear, $lte: endOfYear }
            });

            if (existingYearlyClaim) return false;
        }

        // 3. Registration Date
        if (rules.registrationDateAfter && user.createdAt < rules.registrationDateAfter) return false;

        // 4. Referral Count
        if (rules.referralCount > 0 && user.qualifiedReferrals < rules.referralCount) return false;

        // 5. Deposit Logic (Total Deposited)
        if (rules.minDeposit > 0 && user.totalDeposited < rules.minDeposit) return false;

        // 6. Betting Logic (Total Bets count)
        if (rules.minBets > 0 && user.stats.totalBets < rules.minBets) return false;

        // 7. Prevent duplicate claims for standard/seasonal campaigns
        if (campaign.type !== 'BIRTHDAY') {
            const existingClaim = await Bonus.findOne({ userId, campaignId: campaign.campaignId, status: 'CLAIMED' });
            if (existingClaim) return false;
        }

        return true;
    } catch (error) {
        console.error(`Eligibility check error for campaign ${campaign.campaignId}:`, error);
        return false;
    }
};

/**
 * Processes a campaign claim for a user.
 *
 * @param {Object} io - Socket.io instance
 * @param {string} userId - The user claiming the reward
 * @param {string} campaignId - The unique ID of the campaign
 */
const claimCampaignReward = async (io, userId, campaignId) => {
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            const campaign = await Campaign.findOne({ campaignId, isActive: true }).session(session);
            if (!campaign) throw new Error('Campaign not found');

            // Re-verify eligibility inside transaction for consistency
            const eligible = await checkEligibility(userId, campaign);
            if (!eligible) throw new Error('User not eligible for this campaign');

            const amount = campaign.rewardAmount;
            const title = campaign.name;
            const bonusType = campaign.type === 'BIRTHDAY' ? 'BIRTHDAY_BONUS' : 'CAMPAIGN_REWARD';

            const user = await User.findOneAndUpdate(
                { userId },
                {
                    $inc: {
                        bonusWallet: amount,
                        totalBonusEarned: amount,
                        totalClaimedBonuses: 1
                    }
                },
                { session, new: true }
            );

            await Bonus.create([{
                userId,
                bonusType,
                campaignId: campaign.campaignId,
                title,
                description: campaign.description,
                amount,
                status: 'CLAIMED',
                claimedAt: new Date(),
                transactionReference: `CP-${campaign.campaignId}-${Date.now()}`
            }], { session });

            // Increment campaign claims
            await Campaign.updateOne(
                { campaignId: campaign.campaignId },
                { $inc: { currentClaims: 1 } }
            ).session(session);

            // Notify user with type-specific messaging
            const { createNotification } = require('./notificationHelper');
            let notificationTitle = 'Campaign Reward Received! 🎊';
            let notificationBody = `You've received ₦${(amount / 100).toLocaleString()} from the "${campaign.name}" promotion.`;

            if (campaign.type === 'BIRTHDAY') {
                notificationTitle = 'Happy Birthday! 🎂';
                notificationBody = `We've credited your Bonus Wallet with ₦${(amount / 100).toLocaleString()} to celebrate your special day!`;
            } else if (campaign.type === 'SEASONAL') {
                notificationTitle = `${campaign.name} Reward! 🎁`;
            }

            createNotification(io, {
                uid: userId,
                title: notificationTitle,
                body: notificationBody,
                type: 'bonus',
                priority: 'high',
                category: 'promo',
                icon: campaign.type === 'BIRTHDAY' ? 'cake' : 'celebration',
                idempotencyKey: `campaign_${campaignId}_${userId}_${new Date().getFullYear()}`
            });

            io.to(userId).emit('bonus_update', {
                bonusWallet: user.bonusWallet / 100,
                totalBonusEarned: user.totalBonusEarned / 100
            });

            console.log(`✅ Campaign reward processed: ${campaign.campaignId} for ${userId}`);
        });
    } catch (error) {
        console.error(`Claim error for campaign ${campaignId}:`, error.message);
        throw error;
    } finally {
        session.endSession();
    }
};

module.exports = { checkEligibility, claimCampaignReward };
