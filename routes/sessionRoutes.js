const express = require("express");
const router = express.Router();

module.exports = (sessionManager) => {
  const authMiddleware = (req, res, next) => {
    if (!req.session.user) {
      return res.redirect("/auth/login");
    }
    next();
  };

  router.get("/", (req, res) => {
    try {
      const { key } = req.query;

      if (key) {
        const session = sessionManager.getSession(key);
        if (session) {
          return res.status(200).json({
            status: true,
            message: "Session status retrieved successfully.",
            data: {
              key,
              connected: session?.connected || false,
            },
          });
        } else {
          return res.status(200).json({
            status: false,
            message: `Session with key "${key}" not found.`,
          });
        }
      }

      const sessions = sessionManager.getAllSessions();
      const sessionsStatus = Object.keys(sessions).map((key) => ({
        key,
        connected: sessions[key]?.connected || false,
      }));

      return res.status(200).json({
        status: true,
        message: "All session statuses retrieved successfully.",
        data: sessionsStatus,
      });
    } catch (error) {
      console.error("Failed to retrieve session status:", error);
      res.status(500).json({
        status: false,
        message: "Failed to retrieve session status.",
        error: error.message,
      });
    }
  });

  router.get("/remove", authMiddleware, async (req, res) => {
    const { key } = req.query;

    if (!key) {
      return res
        .status(400)
        .json({ status: false, message: "Key is required." });
    }
    const session = sessionManager.getSession(key);
    if (!session) {
      return res
        .status(404)
        .json({
          status: false,
          message: `Session with key "${key}" not found.`,
        });
    }

    try {
      sessionManager.removeSession(key, true);
    } catch (error) {
      console.error("Failed to delete session folder:", error);
      return res.status(500).json({
        status: false,
        message: "Failed to delete session folder.",
        error: error.message,
      });
    }

    res.status(200).json({
      status: true,
      message: `Session with key "${key}" removed successfully.`,
    });
  });

  // routes/sessionRoute.js

  router.get("/scan", async (req, res) => {
    const { key } = req.query;

    if (!key) {
      return res
        .status(400)
        .json({ status: false, message: "Key is required." });
    }

    try {
      // Trigger session creation
      sessionManager.createSession(key).catch((err) => {
        console.error(`Failed to start session ${key}:`, err.message);
      });

      // Tunggu maksimal 15 detik untuk dapat QR
      const timeoutMs = 15000;
      const checkIntervalMs = 1000;

      let elapsed = 0;
      let session = sessionManager.getSession(key);

      while (
        elapsed < timeoutMs &&
        session &&
        !session.connected &&
        !session.qr
      ) {
        await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
        elapsed += checkIntervalMs;
        session = sessionManager.getSession(key);
      }

      session = sessionManager.getSession(key);

      if (!session) {
        return res
          .status(500)
          .json({ status: false, message: "Session creation failed." });
      }

      if (session.connected) {
        return res.status(200).json({
          status: true,
          message: "Session already connected.",
          connected: true,
        });
      }

      if (session.qr) {
        return res.status(200).json({
          status: true,
          qr: session.qr,
        });
      }

      // Jika timeout
      res.status(202).json({
        status: false,
        message:
          "QR Code generation taking longer than expected. Please retry.",
        action: "retry",
      });
    } catch (error) {
      console.error("Scan route error:", error.message);
      res
        .status(500)
        .json({ status: false, message: "Internal server error." });
    }
  });

  return router;
};
