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
      await sessionManager.removeSession(key, true);
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
    const force = String(req.query.force || '').toLowerCase() === 'true' || req.query.force === '1';

    if (!key) {
      return res
        .status(400)
        .json({ status: false, message: "Key is required." });
    }

    try {
      // If force flag set, move existing creds.json out of the way so a fresh QR is generated.
      if (force) {
        try {
          const fs = require('fs');
          const path = require('path');
          const sessionPath = path.join(sessionManager.folderSession || './.sessions', key);
          const credsPath = path.join(sessionPath, 'creds.json');
          if (fs.existsSync(credsPath)) {
            const bak = path.join(sessionPath, `creds.json.bak.${Date.now()}`);
            await fs.promises.rename(credsPath, bak);
            console.log(`[sessionRoutes] Backed up creds.json for ${key} -> ${bak}`);
          }
        } catch (e) {
          console.warn(`[sessionRoutes] Failed to backup creds for ${key}:`, e && e.message);
        }
      }

      // Trigger session creation (async)
      sessionManager.createSession(key).catch((err) => {
        console.error(`Failed to start session ${key}:`, err && err.message);
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

      // If the session reports an error, return it to the client for diagnostics
      if (session.error) {
        const errMsg = session.lastError || 'Unknown session error';
        console.warn(`[sessionRoutes] session ${key} reports error: ${errMsg}`);
        return res.status(500).json({ status: false, message: `Session error: ${errMsg}` });
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
