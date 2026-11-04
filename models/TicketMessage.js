const mongoose = require('mongoose');

const TicketMessageSchema = new mongoose.Schema({
    ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'SupportTicket', required: true },
    senderType: { type: String, enum: ['User', 'Admin'], required: true },
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    message: { type: String, required: true },
    attachments: [{ type: String }],
    delivered: { type: Boolean, default: false },
    read: { type: Boolean, default: false },
    deliveredAt: { type: Date },
    readAt: { type: Date },
    timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model('TicketMessage', TicketMessageSchema);
