const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../../lib/Utils.js');

module.exports = (billingManager) => {

    router.get("/", authMiddleware, async (req, res) => {
        try {
            const apiKey = req.session.user.api_key;
            let packages = [];  // Gunakan let karena akan diubah dalam try

            try {
                packages = await billingManager.getPackages();  // Tambahkan await
            } catch (error) {
                console.error("Error fetching packages:", error);
            }

            res.render("client/package", {
                apiKey,
                packages,
                title: "Package - w@pi",
                layout: "layouts/client"
            });
        } catch (error) {
            console.error('Error fetching billing data:', error);
            res.status(500).send("Internal Server Error");
        }
    });


    return router;
};