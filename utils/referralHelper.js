const { User } = require('../models');

/**
 * Generates a unique referral code.
 * Format: CP + 5 random alphanumeric characters (e.g., CP83FJ2)
 */
const generateReferralCode = async () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let isUnique = false;
    let code = '';

    while (!isUnique) {
        code = 'CP';
        for (let i = 0; i < 5; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }

        // Check if code exists
        const existingUser = await User.findOne({ referralCode: code });
        if (!existingUser) {
            isUnique = true;
        }
    }

    return code;
};

module.exports = { generateReferralCode };
