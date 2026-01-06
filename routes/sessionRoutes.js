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
      return res.status(404).json({
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
    let force =
      String(req.query.force || "").toLowerCase() === "true" ||
      req.query.force === "1";

    if (!key) {
      return res
        .status(400)
        .json({ status: false, message: "Key is required." });
    }

    try {
      const fs = require("fs");
      const path = require("path");

      // Resolve session path (ensure it works even if folderSession is relative)
      const baseFolder = sessionManager.folderSession || "./.sessions";
      const sessionPath = path.isAbsolute(baseFolder)
        ? path.join(baseFolder, key)
        : path.join(process.cwd(), baseFolder, key);

      // Automatically force fresh session if current one is recorded as logged out
      const existingSession = sessionManager.getSession(key);
      if (
        (existingSession &&
          existingSession.error &&
          existingSession.lastError &&
          existingSession.lastError.includes("loggedOut")) ||
        force
      ) {
        console.log(
          `[sessionRoutes] Session ${key} logout/force detected. Cleaning up for fresh QR generation.`
        );

        // Use removeSession to safely close socket and delete the entire session folder
        // We pass 'disconnected' to avoid marking it as 'removed' in the DB if we can help it,
        // though DeviceManager might still update status.
        await sessionManager.removeSession(key, true, "disconnected");

        // Ensure the directory exists for the fresh start
        if (!fs.existsSync(sessionPath)) {
          fs.mkdirSync(sessionPath, { recursive: true });
        }

        // Reset force to false since we've already cleaned up
        force = false;
      }

      // Trigger session creation (async)
      sessionManager.createSession(key).catch((err) => {
        console.error(`Failed to start session ${key}:`, err && err.message);
      });

      // Wait for QR or connection
      const timeoutMs = 15000;
      const checkIntervalMs = 1000;
      let elapsed = 0;
      let hasAutoReset = false;

      while (elapsed < timeoutMs) {
        let session = sessionManager.getSession(key);

        // If session is already connected or has a QR, we're done
        if (session && (session.connected || session.qr)) break;

        // Proactive detection of logout or fatal errors during wait
        if (
          session &&
          session.error &&
          session.lastError &&
          session.lastError.includes("loggedOut")
        ) {
          if (!hasAutoReset) {
            console.log(
              `[sessionRoutes] Session ${key} logged out during wait. Triggering auto-reset...`
            );
            await sessionManager.removeSession(key, true, "disconnected");

            // Ensure directory exists for fresh start
            if (!fs.existsSync(sessionPath))
              fs.mkdirSync(sessionPath, { recursive: true });

            // Clear state and restart
            sessionManager.createSession(key).catch(() => {});
            hasAutoReset = true;
            // Wait a bit more to see if it starts up
            await new Promise((r) => setTimeout(r, 1000));
            elapsed += 1000;
            continue;
          } else {
            // Already tried resetting once, if it's still failing, we should report it but maybe not as 500
            break;
          }
        }

        await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
        elapsed += checkIntervalMs;
      }

      let session = sessionManager.getSession(key);

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

      // If the session reports an error (especially after our reset attempt)
      if (session.error) {
        const errMsg = session.lastError || "Unknown session error";
        console.warn(`[sessionRoutes] session ${key} reports error: ${errMsg}`);

        // If it's a logout, we treat it as "needs retry" rather than fatal 500
        if (errMsg.includes("loggedOut")) {
          return res.status(202).json({
            status: false,
            message:
              "Session was reset due to logout. Please wait a moment while we generate a new QR.",
            action: "retry",
          });
        }

        return res
          .status(500)
          .json({ status: false, message: `Session error: ${errMsg}` });
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
