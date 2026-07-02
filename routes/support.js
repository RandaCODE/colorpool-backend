const express = require('express');
const router = express.Router();
const { SupportTicket, TicketMessage, AdminNote, User } = require('../models');
const admin = require('firebase-admin');

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
                req.io.of('/admin/support').to(`ticket-${ticket.ticketId}`).emit('messages_read_receipt', {
                    ticketId: ticket.ticketId,
                    messageIds: unreadAdminMessages.map(id => id.toString()),
                    readerType: 'User'
                });
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
            // Real-time message
            req.io.of('/support').to(`ticket-${ticket.ticketId}`).emit('new_message', newMessage);
            req.io.of('/admin/support').to(`ticket-${ticket.ticketId}`).emit('new_message', newMessage);
            // Notification for dashboard
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

        // Mark user messages as read when admin opens the ticket
        const unreadUserMessages = messages.filter(m => m.senderType === 'User' && !m.read).map(m => m._id);
        if (unreadUserMessages.length > 0) {
            await TicketMessage.updateMany(
                { _id: { $in: unreadUserMessages } },
                { $set: { read: true, readAt: new Date() } }
            );
            if (req.io) {
                req.io.of('/support').to(`ticket-${ticket.ticketId}`).emit('messages_read_receipt', {
                    ticketId: ticket.ticketId,
                    messageIds: unreadUserMessages.map(id => id.toString()),
                    readerType: 'Admin'
                });
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
            // Emit to specific ticket room in both namespaces
            req.io.of('/support').to(`ticket-${ticket.ticketId}`).emit('new_message', newMessage);
            req.io.of('/admin/support').to(`ticket-${ticket.ticketId}`).emit('new_message', newMessage);

            // Notification for user app if not in room (general support namespace)
            req.io.of('/support').to(`user-support-${ticket.userId}`).emit('status_update', {
                ticketId: ticket.ticketId,
                status: ticket.status,
                priority: ticket.priority,
                lastMessage: message
            });

            // Meta update for everyone in the room
            const updatePayload = {
                ticketId: ticket.ticketId,
                status: ticket.status,
                priority: ticket.priority
            };
            req.io.of('/support').to(`ticket-${ticket.ticketId}`).emit('ticket_meta_update', updatePayload);
            req.io.of('/admin/support').to(`ticket-${ticket.ticketId}`).emit('ticket_meta_update', updatePayload);

            if (oldStatus !== ticket.status && req.emitSupportStats) req.emitSupportStats();
        }

        res.json({ success: true, data: newMessage });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.patch('/admin/ticket/:ticketId', verifyAdmin, async (req, res) => {
    try {
        const { status, priority, assignedAdmin } = req.body;

        const ticket = await SupportTicket.findOne({ ticketId: req.params.ticketId });
        if (!ticket) return res.status(404).json({ success: false, error: 'Ticket not found' });

        const oldStatus = ticket.status;

        if (status) {
            ticket.status = status;
            if (status === 'Closed' && oldStatus !== 'Closed') ticket.closedAt = new Date();
            if (status === 'Resolved' && oldStatus !== 'Resolved') ticket.resolvedAt = new Date();
        }
        if (priority) ticket.priority = priority;
        if (assignedAdmin) ticket.assignedAdmin = assignedAdmin;

        await ticket.save();

        if (req.io) {
            // Notify both namespaces about the status/priority update
            const updatePayload = {
                ticketId: ticket.ticketId,
                status: ticket.status,
                priority: ticket.priority
            };
            req.io.of('/support').to(`ticket-${ticket.ticketId}`).emit('ticket_meta_update', updatePayload);
            req.io.of('/admin/support').to(`ticket-${ticket.ticketId}`).emit('ticket_meta_update', updatePayload);

            // Also notify user generally
            req.io.of('/support').to(`user-support-${ticket.userId}`).emit('status_update', updatePayload);

            if (oldStatus !== ticket.status && req.emitSupportStats) req.emitSupportStats();
        }

        res.json({ success: true, data: ticket });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
