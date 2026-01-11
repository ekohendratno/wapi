const express = require("express");
const router = express.Router();

module.exports = ({ sessionManager, messageManager }) => {
  router.post("/message", async (req, res) => {
    try {
      const { apiKey, deviceKey } = req.body;
      const messageData = req.body;
      const result = await messageManager.registerMessage(
        apiKey,
        deviceKey,
        messageData
      );

      if (!result.status) {
        return res.status(400).json(result);
      }

      res.status(201).json({
        status: "success",
        message: "Message registered successfully",
        data: result,
      });
    } catch (error) {
      console.error("Error registering message:", error);
      res.status(500).json({
        status: "error",
        message: error.message,
      });
    }
  });

  router.post("/optin", async (req, res) => {
    if (String(process.env.FEATURE_OPT_IN) !== "1") {
      return res.status(403).json({
        status: false,
        message: "Fitur Opt-In sedang dinonaktifkan.",
      });
    }
    try {
      const { apiKey, number, status, source } = req.body;
      if (!apiKey || !number) {
        return res
          .status(400)
          .json({ status: false, message: "apiKey and number are required" });
      }
      const result = await messageManager.registerOptIn(
        apiKey,
        number,
        status,
        source
      );
      res.status(result.status ? 200 : 400).json(result);
    } catch (error) {
      res.status(500).json({ status: false, message: error.message });
    }
  });

  return router;
};
