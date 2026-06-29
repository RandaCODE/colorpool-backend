const mongoose = require('mongoose');

const SupportTicketSchema = new mongoose.Schema({
    ticketId: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },
    username: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String },
    category: {
        type: String,
        enum: [
            'Deposit Issue',
            'Withdrawal Issue',
            'Betting Issue',
            'Wallet Issue',
            'Verification',
            'Bonus',
            'Bug Report',
            'General Inquiry'
        ],
        required: true
    },
    subject: { type: String, required: true },
    description: { type: String, required: true },
    priority: {
        type: String,
        enum: ['Low', 'Medium', 'High', 'Urgent'],
        default: 'Low'
    },
    status: {
        type: String,
        enum: ['Open', 'Pending', 'Resolved', 'Closed'],
        default: 'Open'
    },
    assignedAdmin: { type: String }, // Firebase UID of Admin
    attachments: [{ type: String }],
    lastReplyAt: { type: Date, default: Date.now },
    closedAt: { type: Date }
}, { timestamps: true });

module.exports = mongoose.model('SupportTicket', SupportTicketSchema);
