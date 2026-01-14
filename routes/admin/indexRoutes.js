const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../../lib/Utils.js');

module.exports = ({ pool, billingManager, deviceManager, messageManager, sessionManager, userManager } = {}) => {

    router.get("/", authMiddleware, async (req, res) => {
        try {
            // Gather basic dashboard stats
            const stats = {
                totalBalance: 0,
                totalDevices: 0,
                activeDevices: 0,
                messagesThisMonth: 0,
                lastActiveDevice: null,
                recentMessages: []
            };

            try {
                const [[balanceRow]] = await pool.query('SELECT SUM(balance) AS total FROM balances');
                stats.totalBalance = parseFloat(balanceRow.total) || 0;
            } catch (e) { console.warn('Dashboard: failed to read total balance', e && e.message); }

            try {
                const [[devCount]] = await pool.query("SELECT COUNT(*) AS cnt FROM devices WHERE status != 'deleted'");
                stats.totalDevices = devCount.cnt || 0;
                const [[activeCount]] = await pool.query("SELECT COUNT(*) AS cnt FROM devices WHERE status = 'connected'");
                stats.activeDevices = activeCount.cnt || 0;
            } catch (e) { console.warn('Dashboard: failed to read device counts', e && e.message); }

            try {
                const [[msgCount]] = await pool.query("SELECT COUNT(*) AS cnt FROM messages WHERE MONTH(created_at)=MONTH(CURRENT_DATE()) AND YEAR(created_at)=YEAR(CURRENT_DATE())");
                stats.messagesThisMonth = msgCount.cnt || 0;
            } catch (e) { console.warn('Dashboard: failed to read monthly messages', e && e.message); }

            try {
                const [rows] = await pool.query("SELECT id, name, updated_at FROM devices WHERE status != 'deleted' ORDER BY updated_at DESC LIMIT 1");
                if (rows && rows.length > 0) stats.lastActiveDevice = rows[0];
            } catch (e) { console.warn('Dashboard: failed to read last active device', e && e.message); }

            try {
                const [rmsgs] = await pool.query("SELECT m.id, m.number, m.message, m.status, m.created_at, d.name AS device_name FROM messages m LEFT JOIN devices d ON m.device_id = d.id ORDER BY m.created_at DESC LIMIT 5");
                stats.recentMessages = rmsgs || [];
            } catch (e) { console.warn('Dashboard: failed to read recent messages', e && e.message); }

            res.render("admin/index", { title: "Home - w@pi", layout: "layouts/admin", stats });
        } catch (error) {
            console.error('Admin dashboard error:', error && error.message);
            res.status(500).send('Internal Server Error');
        }
    });

    // API: message stats per day for the last N days (default 14)
    router.get('/api/message-stats', authMiddleware, async (req, res) => {
        try {
            const days = Math.max(7, Math.min(60, parseInt(req.query.days || '14')));
            // Query counts grouped by date
            const [rows] = await pool.query(
                `SELECT DATE(created_at) AS day, COUNT(*) AS cnt
                 FROM messages
                 WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
                 GROUP BY day
                 ORDER BY day ASC`,
                [days - 1]
            );

            // Build a full labels array from oldest -> newest
            const labels = [];
            const data = [];
            const countsByDay = {};
            rows.forEach(r => { const k = (r.day instanceof Date) ? r.day.toISOString().slice(0,10) : String(r.day); countsByDay[k] = Number(r.cnt || 0); });

            const today = new Date();
            for (let i = days - 1; i >= 0; i--) {
                const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
                const key = d.toISOString().slice(0,10);
                labels.push(key);
                data.push(countsByDay[key] || 0);
            }

            res.json({ labels, data });
        } catch (err) {
            console.error('message-stats API error:', err && err.message);
            res.status(500).json({ error: 'Failed to fetch stats' });
        }
    });

    return router;
};