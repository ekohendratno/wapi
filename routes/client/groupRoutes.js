const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../../lib/Utils.js');

module.exports = ({sessionManager, deviceManager, billingManager}) => {

    router.get("/", authMiddleware, async (req, res) => {
        try {
            const apiKey = req.session.user.api_key;
    
            res.render("client/group", {
                apiKey: apiKey,
                title: "Group - w@pi",
                layout: "layouts/client"
            });
        } catch (error) {
            console.error('Error:', error);
            res.status(500).send("Internal Server Error");
        }
    });

    return router;
};