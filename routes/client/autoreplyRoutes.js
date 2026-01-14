const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../../lib/Utils.js");

module.exports = ({ sessionManager, autoreplyManager, deviceManager }) => {
  router.get("/", authMiddleware, async (req, res) => {
    const apiKey = req.session.user.api_key;
    const autoReplies = await autoreplyManager.getAutoReply(
      req.session.user.api_key
    );
    const devices = await deviceManager.getDevices(apiKey, {
      status: "connected",
    });
    res.render("client/autoreply", {
      apiKey,
      devices: devices || [],
      autoReplies: autoReplies || [],
      title: "Home - w@pi",
      layout: "layouts/client",
    });
  });

  router.get("/:id", authMiddleware, async (req, res) => {
    try {
      const { id } = req.params;
      const autoReply = await autoreplyManager.getAutoReply(
        req.session.user.api_key,
        id
      );

      res.json({
        status: true,
        data: autoReply,
      });
    } catch (error) {
      console.error("Error fetching auto-reply by ID:", error);
      res.status(error.isBoom ? error.output.statusCode : 500).json({
        status: false,
        message: error.message || "Internal Server Error",
      });
    }
  });

  router.post("/register", authMiddleware, async (req, res) => {
    const {
      apiKey,
      id,
      keyword,
      response,
      status,
      is_for_personal,
      is_for_group,
      device,
    } = req.body;
    try {
      const autoreplyData = await autoreplyManager.registerAutoReply(
        apiKey,
        id,
        keyword,
        response,
        status,
        is_for_personal,
        is_for_group,
        device
      );

      res.json({
        status: true,
        data: {
          id: autoreplyData.id,
          keyword: autoreplyData.keyword,
          status: autoreplyData.status,
          is_for_personal: autoreplyData.is_for_personal,
          is_for_group: autoreplyData.is_for_group,
          device: device,
        },
      });
    } catch (error) {
      res.status(500).json({
        status: false,
        message: error.message,
      });
    }
  });

  router.delete("/remove", authMiddleware, async (req, res) => {
    try {
      const { apiKey, id } = req.query;
      const result = await autoreplyManager.removeAutoReply(apiKey, id);
      res.json({ status: true, message: "AutoReply deleted successfully" });
    } catch (error) {
      console.error("Delete autoreply error:", error);
      const statusCode = error.output?.statusCode || 500;
      res.status(statusCode).json({
        status: false,
        message: error.message,
      });
    }
  });

  return router;
};
