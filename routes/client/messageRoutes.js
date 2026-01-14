const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../../lib/Utils.js");

module.exports = ({ sessionManager, messageManager, deviceManager }) => {
  router.get("/", authMiddleware, async (req, res) => {
    try {
      const apiKey = req.session.user.api_key;
      const devices = await deviceManager.getDevices(apiKey, {
        status: "connected",
      });
      res.render("client/message", {
        apiKey,
        devices: devices || [],
        title: "Messages - w@pi",
        layout: "layouts/client",
      });
    } catch (error) {
      console.error("Error:", error);
      res.status(500).send("Internal Server Error");
    }
  });

  router.get("/data", authMiddleware, async (req, res) => {
    const { status = "all", page = 1, limit = 30 } = req.query;
    try {
      const apiKey = req.session.user.api_key;
      const messages = await messageManager.getMessages(
        apiKey,
        status,
        parseInt(page),
        parseInt(limit)
      );

      res.json({
        success: true,
        messages: messages.messages || [],
        counts: messages.counts || [],
        pagination: messages.pagination,
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ success: false, message: "Terjadi kesalahan" });
    }
  });

  router.delete("/remove", authMiddleware, async (req, res) => {
    try {
      const { apiKey, id } = req.query;
      const result = await messageManager.removeMessage(apiKey, id);
      res.json({ status: true, message: "Message deleted successfully" });
    } catch (error) {
      console.error("Delete message error:", error);
      const statusCode = error.output?.statusCode || 500;
      res.status(statusCode).json({
        status: false,
        message: error.message,
      });
    }
  });

  router.post("/retry", authMiddleware, async (req, res) => {
    try {
      const { apiKey, id } = req.query;
      const result = await messageManager.retryMessage(apiKey, id);
      res.json({ status: true, message: "Message retry successfully" });
    } catch (error) {
      console.error("Retry message error:", error);
      const statusCode = error.output?.statusCode || 500;
      res.status(statusCode).json({
        status: false,
        message: error.message,
      });
    }
  });

  return router;
};
