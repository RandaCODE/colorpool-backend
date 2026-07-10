const admin = require('firebase-admin');

/**
 * Creates a notification in Firestore and emits a Socket.IO event.
 *
 * @param {Object} io - Socket.IO server instance
 * @param {Object} params - Notification parameters
 * @param {string} params.uid - User ID
 * @param {string} params.title - Notification title
 * @param {string} params.message - Notification message
 * @param {string} params.type - Notification type (wallet, bet, security, etc.)
 * @param {string} [params.priority='normal'] - Priority (low, normal, high)
 * @param {Object} [params.metadata={}] - Optional metadata
 * @param {string} [params.icon=''] - Optional icon identifier
 * @param {string} [params.action=''] - Optional deep link action
 */
const createNotification = async (io, {
    uid,
    title,
    message,
    type,
    priority = 'normal',
    metadata = {},
    icon = '',
    action = ''
}) => {
    try {
        if (!uid || uid === 'user1') return null;

        const db = admin.firestore();
        const notificationData = {
            title,
            message,
            type,
            icon,
            priority,
            metadata,
            action,
            isRead: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };

        const docRef = await db.collection('users').doc(uid).collection('notifications').add(notificationData);

        // Emit Socket.IO event for instant update
        if (io) {
            const socketNotification = {
                id: docRef.id,
                ...notificationData,
                createdAt: new Date()
            };
            io.to(uid).emit('new_notification', socketNotification);
            io.to(uid).emit('notification_count_update');
        }

        return docRef.id;
    } catch (error) {
        console.error('Error creating notification:', error);
        return null;
    }
};

module.exports = { createNotification };
