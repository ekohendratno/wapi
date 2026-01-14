const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../../lib/Utils.js');

module.exports = (billingManager, pool) => {

    // List packages page
    router.get("/", authMiddleware, async (req, res) => {
        try {
            let packages = [];

            try {
                packages = await billingManager.getPackages();
            } catch (error) {
                console.error("Error fetching packages:", error);
            }

            res.render("admin/package", {
                packages,
                title: "Package - w@pi",
                layout: "layouts/admin"
            });
        } catch (error) {
            console.error('Error fetching billing data:', error);
            res.status(500).send("Internal Server Error");
        }
    });

    // Get package by id (JSON)
    router.get('/edit/:id', authMiddleware, async (req, res) => {
        try {
            const id = Number(req.params.id || 0);
            if (!id) return res.status(400).json({ status: false, message: 'Invalid id' });
            const [rows] = await pool.query('SELECT * FROM packages WHERE id = ? LIMIT 1', [id]);
            if (!rows || rows.length === 0) return res.status(404).json({ status: false, message: 'Not found' });
            return res.json({ status: true, data: rows[0] });
        } catch (err) {
            console.error('admin.package.edit error', err && err.message);
            return res.status(500).json({ status: false, message: 'Server error' });
        }
    });

    // Create or update package
    router.post('/save', authMiddleware, async (req, res) => {
        try {
            const id = Number(req.body.id || 0);
            const name = String(req.body.name || '').trim();
            const price = parseFloat(req.body.price || 0) || 0;
            const duration = parseInt(req.body.duration || 0) || 0;
            const message_limit = parseInt(req.body.message_limit || 0) || 0;
            const description = String(req.body.description || '').trim();
            const recomended = req.body.recomended ? 1 : 0;
            const active = req.body.active ? 1 : 0;

            if (!name) return res.json({ status: false, message: 'Nama paket diperlukan' });

            if (id > 0) {
                // update
                await pool.query('UPDATE packages SET name = ?, price = ?, duration = ?, description = ?, recomended = ?, message_limit = ?, active = ?, updated_at = NOW() WHERE id = ?', [name, price, duration, description, recomended, message_limit, active, id]);
                return res.json({ status: true, message: 'Package updated' });
            } else {
                // insert
                await pool.query('INSERT INTO packages (name, price, duration, description, recomended, message_limit, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())', [name, price, duration, description, recomended, message_limit, active]);
                return res.json({ status: true, message: 'Package created' });
            }
        } catch (err) {
            console.error('admin.package.save error', err && err.message);
            return res.status(500).json({ status: false, message: 'Server error' });
        }
    });

    // Delete package
    router.delete('/delete/:id', authMiddleware, async (req, res) => {
        try {
            const id = Number(req.params.id || 0);
            if (!id) return res.status(400).json({ status: false, message: 'Invalid id' });
            await pool.query('DELETE FROM packages WHERE id = ?', [id]);
            return res.json({ status: true });
        } catch (err) {
            console.error('admin.package.delete error', err && err.message);
            return res.status(500).json({ status: false, message: 'Server error' });
        }
    });

    return router;
};