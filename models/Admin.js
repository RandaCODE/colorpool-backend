const mongoose = require('mongoose');

const AdminSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    // Added temporarily to debug existing production data
    password: { type: String },
    role: {
        type: String,
        enum: ['super_admin', 'admin', 'finance_admin'],
        default: 'admin'
    },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Admin', AdminSchema);
