const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../../lib/Utils.js');

module.exports = ({sessionManager, deviceManager, messageManager, billingManager}) => {

    router.get("/", authMiddleware, async (req, res) => {
        const sessions = sessionManager.getAllSessions();
        const apiKey = req.session.user.api_key;
        const devices = await deviceManager.getDevices(apiKey);

        
        const countDeviceLast = await deviceManager.getDevicesWithLastActive(apiKey);
        const countMessage = await messageManager.getMessageCounts(apiKey);
        const countDevice = await deviceManager.getActiveDeviceCount(apiKey);
        const countSummary = await billingManager.getBalanceSummary(apiKey);
        const messageStatistics = await messageManager.getMessageStatistics(apiKey);
        const messagesLast = await messageManager.getMessagesLast(apiKey);

        res.render("client/index", { messagesLast, messageStatistics, countDeviceLast, countMessage, countDevice, countSummary, devices: devices || [], apiKey: apiKey, sessions, title: "Home - w@pi", layout: "layouts/client" });
    });


    router.get("/status", authMiddleware, async (req, res) => {
        const { key } = req.query;

        if (!key) {
            return res.status(400).json({ status: false, message: "Key is required." });
        }

        res.render("client/status", { key: key, title: "Home", layout: "layouts/client" });
    });
    return router;
};