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

        // In this project, Admin status is checked against the User model's isAdmin flag
        const user = await User.findOne({ userId: decodedToken.uid });
        if (!user || !user.isAdmin) return res.status(403).json({ success: false, error: 'Forbidden' });

        req.admin = decodedToken;
        next();
    } catch (error) { return res.status(401).json({ success: false, error: 'Invalid session' }); }
}

// Helper to generate Ticket ID
const generateTicketId = () => {
    return 'TK-' + Math.random().toString(36).substr(2, 9).toUpperCase();
};

// =======================
// USER ENDPOINTS
// =======================

// Create Ticket
router.post('/create', verifyUser, async (req, res) => {
    try {
        const { category, subject, description, phone, attachments } = req.body;
        const user = await User.findOne({ userId: req.user.uid });

        const ticket = new SupportTicket({
            ticketId: generateTicketId(),
            userId: req.user.uid,
            username: user?.email?.split('@')[0] || 'User',
            email: req.user.email,
            phone: phone,
            category,
            subject,
            description,
            attachments
        });

        await ticket.save();

        // Save initial message as first conversation item
        const message = new TicketMessage({
            ticketId: ticket._id,
            senderType: 'User',
            senderId: req.user.uid,
            message: description,
            attachments
        });
        await message.save();

        res.json({ success: true, data: ticket });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get User's Tickets
router.get('/my-tickets', verifyUser, async (req, res) => {
    try {
        const tickets = await SupportTicket.find({ userId: req.user.uid }).sort({ updatedAt: -1 });
        res.json({ success: true, data: tickets });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get Ticket Details (User)
router.get('/ticket/:ticketId', verifyUser, async (req, res) => {
    try {
        const ticket = await SupportTicket.findOne({ ticketId: req.params.ticketId, userId: req.user.uid });
        if (!ticket) return res.status(404).json({ success: false, error: 'Ticket not found' });

        const messages = await TicketMessage.find({ ticketId: ticket._id }).sort({ timestamp: 1 });
        res.json({ success: true, data: { ticket, messages } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Reply to Ticket (User)
router.post('/ticket/:ticketId/reply', verifyUser, async (req, res) => {
    try {
        const ticket = await SupportTicket.findOne({ ticketId: req.params.ticketId, userId: req.user.uid });
        if (!ticket) return res.status(404).json({ success: false, error: 'Ticket not found' });
        if (ticket.status === 'Closed') return res.status(400).json({ success: false, error: 'Ticket is closed' });

        const { message, attachments } = req.body;
        const newMessage = new TicketMessage({
            ticketId: ticket._id,
            senderType: 'User',
            senderId: req.user.uid,
            message,
            attachments
        });

        await newMessage.save();

        ticket.status = 'Open'; // Re-open or keep open if user replies
        ticket.lastReplyAt = new Date();
        await ticket.save();

        res.json({ success: true, data: newMessage });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// =======================
// ADMIN ENDPOINTS
// =======================

// List All Tickets
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

// Get Ticket Details (Admin)
router.get('/admin/ticket/:ticketId', verifyAdmin, async (req, res) => {
    try {
        const ticket = await SupportTicket.findOne({ ticketId: req.params.ticketId });
        if (!ticket) return res.status(404).json({ success: false, error: 'Ticket not found' });

        const messages = await TicketMessage.find({ ticketId: ticket._id }).sort({ timestamp: 1 });
        const notes = await AdminNote.find({ ticketId: ticket._id }).sort({ createdAt: -1 });

        res.json({ success: true, data: { ticket, messages, notes } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Reply to Ticket (Admin)
router.post('/admin/ticket/:ticketId/reply', verifyAdmin, async (req, res) => {
    try {
        const ticket = await SupportTicket.findOne({ ticketId: req.params.ticketId });
        if (!ticket) return res.status(404).json({ success: false, error: 'Ticket not found' });

        const { message, attachments, status } = req.body;
        const newMessage = new TicketMessage({
            ticketId: ticket._id,
            senderType: 'Admin',
            senderId: req.admin.uid,
            message,
            attachments
        });

        await newMessage.save();

        ticket.status = status || 'Pending';
        ticket.lastReplyAt = new Date();
        ticket.assignedAdmin = req.admin.uid;
        await ticket.save();

        res.json({ success: true, data: newMessage });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Add Admin Note
router.post('/admin/ticket/:ticketId/note', verifyAdmin, async (req, res) => {
    try {
        const ticket = await SupportTicket.findOne({ ticketId: req.params.ticketId });
        if (!ticket) return res.status(404).json({ success: false, error: 'Ticket not found' });

        const { note } = req.body;
        const newNote = new AdminNote({
            ticketId: ticket._id,
            adminId: req.admin.uid,
            note
        });

        await newNote.save();
        res.json({ success: true, data: newNote });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Update Ticket Status/Priority/Assignee
router.patch('/admin/ticket/:ticketId', verifyAdmin, async (req, res) => {
    try {
        const { status, priority, assignedAdmin } = req.body;
        const update = {};
        if (status) {
            update.status = status;
            if (status === 'Closed') update.closedAt = new Date();
        }
        if (priority) update.priority = priority;
        if (assignedAdmin) update.assignedAdmin = assignedAdmin;

        const ticket = await SupportTicket.findOneAndUpdate(
            { ticketId: req.params.ticketId },
            { $set: update },
            { new: true }
        );

        if (!ticket) return res.status(404).json({ success: false, error: 'Ticket not found' });
        res.json({ success: true, data: ticket });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Dashboard Statistics
router.get('/admin/stats', verifyAdmin, async (req, res) => {
    try {
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const startOfTomorrow = new Date(startOfToday);
        startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);

        const stats = {
            open: await SupportTicket.countDocuments({ status: 'Open' }),
            pending: await SupportTicket.countDocuments({ status: 'Pending' }),
            resolvedToday: await SupportTicket.countDocuments({
                status: 'Resolved',
                updatedAt: { $gte: startOfToday, $lt: startOfTomorrow }
            }),
            closedToday: await SupportTicket.countDocuments({
                status: 'Closed',
                closedAt: { $gte: startOfToday, $lt: startOfTomorrow }
            }),
            ticketsToday: await SupportTicket.countDocuments({
                createdAt: { $gte: startOfToday, $lt: startOfTomorrow }
            }),
            // Weekly/Monthly stats
            ticketsThisWeek: await SupportTicket.countDocuments({
                createdAt: { $gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) }
            }),
            ticketsThisMonth: await SupportTicket.countDocuments({
                createdAt: { $gte: new Date(now.getFullYear(), now.getMonth(), 1) }
            })
        };

        // Average Response Time (Simplistic implementation: time between creation and first Admin message)
        // In a real scenario, this would be more complex

        // Most common category
        const commonCategory = await SupportTicket.aggregate([
            { $group: { _id: "$category", count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 1 }
        ]);
        stats.mostCommonCategory = commonCategory[0]?._id || 'None';

        res.json({ success: true, data: stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
