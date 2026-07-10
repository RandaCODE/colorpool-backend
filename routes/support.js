const express = require('express');
const router = express.Router();
const { SupportTicket, TicketMessage, AdminNote, User } = require('../models');
const admin = require('firebase-admin');
const { createNotification } = require('../utils/notificationHelper');

// Middleware to verify Firebase token for Users
async function verifyUser(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ success: false, error: 'Unauthorized' });
        const decodedToken = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
        req.user = decodedToken;
        next();
    } catch (error) { return res.status(401).json({ success: false, error: 'Invalid session' }); }
}

// Middleware to verify Firebase token and Admin status
async function verifyAdmin(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ success: false, error: 'Unauthorized' });
        const decodedToken = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);

        const user = await User.findOne({ userId: decodedToken.uid });
        if (!user || !user.isAdmin) return res.status(403).json({ success: false, error: 'Forbidden' });

        req.admin = decodedToken;
        next();
    } catch (error) { return res.status(401).json({ success: false, error: 'Invalid session' }); }
}

const generateTicketId = () => {
    return 'TK-' + Math.random().toString(36).substr(2, 9).toUpperCase();
};

// =======================
// USER ENDPOINTS
// =======================

router.post('/create', verifyUser, async (req, res) => {
    try {
        const { category, subject, description, phone, attachments } = req.body;
        const user = await User.findOne({ userId: req.user.uid });
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });

        const ticket = new SupportTicket({
            ticketId: generateTicketId(),
            userId: req.user.uid,
            username: user?.email?.split('@')[0] || 'User',
            email: req.user.email,
            phone: phone,
            category,
            subject,
            description,
            attachments,
            status: 'Open',
            priority: 'Normal'
        });

        await ticket.save();

        const message = new TicketMessage({
            ticketId: ticket._id,
            senderType: 'User',
            senderId: user._id,
            message: description,
            attachments,
            delivered: true,
            deliveredAt: new Date()
        });
        await message.save();

        if (req.io) {
            req.io.of('/admin/support').emit('new_ticket', ticket);

            // Notification: Ticket Created
            createNotification(req.io, {
                uid: req.user.uid,
                title: 'Ticket Created 📩',
                body: `Your support ticket ${ticket.ticketId} has been successfully created.`,
                type: 'support',
                priority: 'normal',
                route: '/support_chat',
                payload: { ticketId: ticket.ticketId },
                category: 'support',
                icon: 'confirmation_number',
                idempotencyKey: `ticket_created_${ticket.ticketId}`
            });

            if (req.emitSupportStats) req.emitSupportStats();
        }

        res.json({ success: true, data: ticket });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/my-tickets', verifyUser, async (req, res) => {
    try {
        const tickets = await SupportTicket.find({ userId: req.user.uid }).sort({ updatedAt: -1 });
        res.json({ success: true, data: tickets });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/ticket/:ticketId', verifyUser, async (req, res) => {
    try {
        const ticket = await SupportTicket.findOne({ ticketId: req.params.ticketId, userId: req.user.uid });
        if (!ticket) return res.status(404).json({ success: false, error: 'Ticket not found' });

        const messages = await TicketMessage.find({ ticketId: ticket._id }).sort({ timestamp: 1 });

        // Mark admin messages as read when user opens the ticket
        const unreadAdminMessages = messages.filter(m => m.senderType === 'Admin' && !m.read).map(m => m._id);
        if (unreadAdminMessages.length > 0) {
            await TicketMessage.updateMany(
                { _id: { $in: unreadAdminMessages } },
                { $set: { read: true, readAt: new Date() } }
            );
            if (req.io) {
                const receiptPayload = {
                    ticketId: ticket.ticketId,
                    messageIds: unreadAdminMessages.map(id => id.toString()),
                    readerType: 'User'
                };
                req.io.of('/admin/support').to(`ticket-${ticket.ticketId}`).emit('messages_read_receipt', receiptPayload);
                req.io.of('/admin/support').to(`ticket-${ticket.ticketId}`).emit('messageSeen', receiptPayload);
            }
        }

        res.json({ success: true, data: { ticket, messages } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/ticket/:ticketId/reply', verifyUser, async (req, res) => {
    try {
        const ticket = await SupportTicket.findOne({ ticketId: req.params.ticketId, userId: req.user.uid });
        if (!ticket) return res.status(404).json({ success: false, error: 'Ticket not found' });
        if (ticket.status === 'Closed') return res.status(400).json({ success: false, error: 'Ticket is closed' });

        const user = await User.findOne({ userId: req.user.uid });
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });

        const { message, attachments } = req.body;
        const newMessage = new TicketMessage({
            ticketId: ticket._id,
            senderType: 'User',
            senderId: user._id,
            message,
            attachments,
            delivered: true,
            deliveredAt: new Date()
        });

        await newMessage.save();

        const oldStatus = ticket.status;
        if (ticket.status !== 'Open') {
            ticket.status = 'Open';
        }
        ticket.lastReplyAt = new Date();
        await ticket.save();

        if (req.io) {
            req.io.of('/support').to(`ticket-${ticket.ticketId}`).emit('new_message', newMessage);
            req.io.of('/admin/support').to(`ticket-${ticket.ticketId}`).emit('new_message', newMessage);

            if (oldStatus !== 'Open') {
                const metaPayload = { ticketId: ticket.ticketId, status: ticket.status, priority: ticket.priority };
                req.io.of('/support').to(`ticket-${ticket.ticketId}`).emit('ticketStatusChanged', metaPayload);
                req.io.of('/admin/support').to(`ticket-${ticket.ticketId}`).emit('ticketStatusChanged', metaPayload);
            }

            req.io.of('/admin/support').emit('ticket_update', {
                ticketId: ticket.ticketId,
                status: ticket.status,
                priority: ticket.priority,
                lastMessage: message
            });
            if (oldStatus !== 'Open' && req.emitSupportStats) req.emitSupportStats();
        }

        res.json({ success: true, data: newMessage });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// =======================
// ADMIN ENDPOINTS
// =======================

router.get('/admin/stats', verifyAdmin, async (req, res) => {
    try {
        const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
        const open = await SupportTicket.countDocuments({ status: 'Open' });
        const pending = await SupportTicket.countDocuments({ status: 'Pending' });
        const resolvedToday = await SupportTicket.countDocuments({ status: 'Resolved', resolvedAt: { $gte: startOfToday } });
        const closedToday = await SupportTicket.countDocuments({ status: 'Closed', closedAt: { $gte: startOfToday } });

        res.json({
            success: true,
            data: { open, pending, resolvedToday, closedToday }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/admin/list', verifyAdmin, async (req, res) => {
    try {
        const { status, priority, category, search, page = 1, limit = 50 } = req.query;
        let query = {};

        if (status) query.status = status;
        if (priority) query.priority = priority;
        if (category) query.category = category;

        if (search) {
            query.$or = [
                { ticketId: { $regex: search, $options: 'i' } },
                { username: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } },
                { phone: { $regex: search, $options: 'i' } },
                { subject: { $regex: search, $options: 'i' } }
            ];
        }

        const tickets = await SupportTicket.find(query)
            .sort({ lastReplyAt: -1 })
            .limit(limit * 1)
            .skip((page - 1) * limit);

        const count = await SupportTicket.countDocuments(query);

        res.json({
            success: true,
            data: {
                tickets,
                totalPages: Math.ceil(count / limit),
                currentPage: page,
                totalTickets: count
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/admin/ticket/:ticketId', verifyAdmin, async (req, res) => {
    try {
        const ticket = await SupportTicket.findOne({ ticketId: req.params.ticketId });
        if (!ticket) return res.status(404).json({ success: false, error: 'Ticket not found' });

        const messages = await TicketMessage.find({ ticketId: ticket._id }).sort({ timestamp: 1 });
        const notes = await AdminNote.find({ ticketId: ticket._id }).sort({ createdAt: -1 });

        const unreadUserMessages = messages.filter(m => m.senderType === 'User' && !m.read).map(m => m._id);
        if (unreadUserMessages.length > 0) {
            await TicketMessage.updateMany(
                { _id: { $in: unreadUserMessages } },
                { $set: { read: true, readAt: new Date() } }
            );
            if (req.io) {
                const receiptPayload = {
                    ticketId: ticket.ticketId,
                    messageIds: unreadUserMessages.map(id => id.toString()),
                    readerType: 'Admin'
                };
                req.io.of('/support').to(`ticket-${ticket.ticketId}`).emit('messageSeen', receiptPayload);
                req.io.of('/admin/support').to(`ticket-${ticket.ticketId}`).emit('messageSeen', receiptPayload);
            }
        }

        res.json({ success: true, data: { ticket, messages, notes } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/admin/ticket/:ticketId/reply', verifyAdmin, async (req, res) => {
    try {
        const ticket = await SupportTicket.findOne({ ticketId: req.params.ticketId });
        if (!ticket) return res.status(404).json({ success: false, error: 'Ticket not found' });

        const adminUser = await User.findOne({ userId: req.admin.uid });
        if (!adminUser) return res.status(404).json({ success: false, error: 'Admin user not found' });

        const { message, attachments, status } = req.body;
        const newMessage = new TicketMessage({
            ticketId: ticket._id,
            senderType: 'Admin',
            senderId: adminUser._id,
            message,
            attachments,
            delivered: true,
            deliveredAt: new Date()
        });

        await newMessage.save();

        const oldStatus = ticket.status;
        const newStatus = status || 'Pending';
        ticket.status = newStatus;
        ticket.lastReplyAt = new Date();
        ticket.assignedAdmin = req.admin.uid;

        if (newStatus === 'Resolved' && oldStatus !== 'Resolved') ticket.resolvedAt = new Date();
        if (newStatus === 'Closed' && oldStatus !== 'Closed') ticket.closedAt = new Date();

        await ticket.save();

        if (req.io) {
            req.io.of('/support').to(`ticket-${ticket.ticketId}`).emit('new_message', newMessage);
            req.io.of('/admin/support').to(`ticket-${ticket.ticketId}`).emit('new_message', newMessage);

            // Notification: Support Reply
            createNotification(req.io, {
                uid: ticket.userId,
                title: 'Support Reply 🎧',
                body: `An admin has replied to your ticket ${ticket.ticketId}.`,
                type: 'support',
                priority: 'high',
                route: '/support_chat',
                payload: { ticketId: ticket.ticketId },
                category: 'support',
                icon: 'support_agent',
                idempotencyKey: `reply_${newMessage._id}`
            });

            const updatePayload = { ticketId: ticket.ticketId, status: ticket.status, priority: ticket.priority };
            req.io.of('/support').to(`ticket-${ticket.ticketId}`).emit('ticketStatusChanged', updatePayload);
            req.io.of('/admin/support').to(`ticket-${ticket.ticketId}`).emit('ticketStatusChanged', updatePayload);

            if (oldStatus !== ticket.status && req.emitSupportStats) req.emitSupportStats();
        }

        res.json({ success: true, data: newMessage });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/admin/ticket/:ticketId/status', verifyAdmin, async (req, res) => {
    try {
        const { status } = req.body;
        const ticket = await SupportTicket.findOne({ ticketId: req.params.ticketId });
        if (!ticket) return res.status(404).json({ success: false, error: 'Ticket not found' });

        const oldStatus = ticket.status;
        ticket.status = status;
        ticket.lastReplyAt = new Date();

        if (status === 'Resolved' && oldStatus !== 'Resolved') ticket.resolvedAt = new Date();
        if (status === 'Closed' && oldStatus !== 'Closed') ticket.closedAt = new Date();

        await ticket.save();

        if (req.io) {
            const updatePayload = { ticketId: ticket.ticketId, status: ticket.status, priority: ticket.priority };
            req.io.of('/support').to(`ticket-${ticket.ticketId}`).emit('ticketStatusChanged', updatePayload);
            req.io.of('/admin/support').to(`ticket-${ticket.ticketId}`).emit('ticketStatusChanged', updatePayload);

            // Notification: Ticket Status Update
            createNotification(req.io, {
                uid: ticket.userId,
                title: `Ticket ${status} 🎫`,
                body: `Your ticket ${ticket.ticketId} has been marked as ${status}.`,
                type: 'support',
                priority: 'normal',
                route: '/support_chat',
                payload: { ticketId: ticket.ticketId },
                category: 'support',
                icon: status === 'Closed' ? 'lock' : 'check_circle',
                idempotencyKey: `ticket_status_${ticket.ticketId}_${status}`
            });

            if (oldStatus !== ticket.status && req.emitSupportStats) req.emitSupportStats();
        }

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/admin/ticket/:ticketId/note', verifyAdmin, async (req, res) => {
    try {
        const { note } = req.body;
        const ticket = await SupportTicket.findOne({ ticketId: req.params.ticketId });
        if (!ticket) return res.status(404).json({ success: false, error: 'Ticket not found' });

        const adminNote = new AdminNote({
            ticketId: ticket._id,
            adminId: req.admin.uid,
            note
        });

        await adminNote.save();
        res.json({ success: true, data: adminNote });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
