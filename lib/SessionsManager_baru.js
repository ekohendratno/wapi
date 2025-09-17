const path = require("path");
const fs = require("fs");
const qrcode = require("qrcode");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const moment = require("moment-timezone");
const { generateGroupID } = require("../lib/Generate");

const sessionManagerInstances = new Set();

class SessionManager {
  constructor(pool, io, deviceManager, folderSession = "../.sessions") {
    this.pool = pool;
    this.io = io;
    this.folderSession = folderSession;
    this.sessions = {};
    this.reconnectDelays = {};
    this.deviceManager = deviceManager;
    this.shuttingDown = false;

    if (!fs.existsSync(this.folderSession)) {
      fs.mkdirSync(this.folderSession, { recursive: true });
      fs.chmodSync(this.folderSession, 0o750);
    }

    sessionManagerInstances.add(this);

    if (!SessionManager._shutdownHandlersRegistered) {
      SessionManager._shutdownHandlersRegistered = true;
      const markAllShuttingDown = (sig) => {
        console.log(
          `⚠️ Process signal ${sig} received — marking SessionManager instances as shutting down`
        );
        for (const inst of sessionManagerInstances) {
          inst.shuttingDown = true;
        }
      };
      process.on("SIGINT", () => markAllShuttingDown("SIGINT"));
      process.on("SIGTERM", () => markAllShuttingDown("SIGTERM"));
      process.on("SIGHUP", () => markAllShuttingDown("SIGHUP"));
      process.on("beforeExit", () => markAllShuttingDown("beforeExit"));
    }
  }

  /**
   * Initialize existing session folders (called on app start)
   */
  async initSessions() {
    console.log("🔄 Initializing sessions with anti-disconnect protection...");
    const sessionKeys = fs
      .readdirSync(this.folderSession)
      .filter((file) =>
        fs.statSync(path.join(this.folderSession, file)).isDirectory()
      );

    await Promise.all(
      sessionKeys.map(async (key) => {
        const sessionPath = path.join(this.folderSession, key);
        try {
          // check if creds.json exists & accessible
          await fs.promises.access(
            path.join(sessionPath, "creds.json"),
            fs.constants.R_OK | fs.constants.W_OK
          );
          // random small delay to avoid spikes
          setTimeout(
            () => this.forceReconnect(key).catch(console.error),
            Math.random() * 3000
          );
        } catch (err) {
          console.warn(
            `⚠️ Session ${key} exists but creds.json missing or inaccessible. Will attempt to recreate.`
          );
          setTimeout(
            () => this.forceReconnect(key).catch(console.error),
            Math.random() * 3000
          );
        }
      })
    );
    console.log("✅ Session initialization routine enqueued.");
  }

  _isLoggedOutError(err) {
    if (!err) return false;
    try {
      const code =
        err?.output?.statusCode ?? err?.status ?? err?.statusCode ?? null;
      if (code !== null && String(code) === String(DisconnectReason.loggedOut))
        return true;
      const reason = err?.reason ?? err?.output?.payload?.reason ?? null;
      if (reason && String(reason) === String(DisconnectReason.loggedOut))
        return true;
    } catch (e) {}
    return false;
  }

  async createSession(key) {
    if (!this.sessions[key]) {
      this.sessions[key] = {
        socket: null,
        qr: null,
        connected: false,
        lastActive: Date.now(),
        reconnectCount: 0,
        lastQRUpdate: 0,
        reconnectTimer: null,
        backupInterval: null,
        heartbeat: null,
        removing: false,
        permanentRemoved: false,
        creating: false,
        lastError: null,
      };
    }

    const session = this.sessions[key];
    const sessionPath = path.join(this.folderSession, key);

    if (session.creating) return;
    session.creating = true;

    try {
      if (!fs.existsSync(this.folderSession)) {
        fs.mkdirSync(this.folderSession, { recursive: true });
        fs.chmodSync(this.folderSession, 0o750);
      }
      if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
        fs.chmodSync(sessionPath, 0o750);
      }

      if (session.socket) {
        try {
          if (typeof session.socket.logout === "function") await session.socket.logout();
          else if (typeof session.socket.close === "function") session.socket.close();
        } catch {}
        session.socket = null;
      }

      const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

      const backupCreds = () => {
        try {
          const credsPath = path.join(sessionPath, "creds.json");
          const backupPath = path.join(sessionPath, "creds.backup.json");
          if (fs.existsSync(credsPath)) fs.copyFileSync(credsPath, backupPath);
        } catch (err) {
          console.error(`❌ Failed to backup creds for ${key}:`, err?.message || err);
        }
      };

      backupCreds();
      if (session.backupInterval) clearInterval(session.backupInterval);
      session.backupInterval = setInterval(backupCreds, 5 * 60 * 1000);

      const socket = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: ["Ubuntu", "Chrome", "120.0.6099.109"],
        markOnlineOnConnect: true,
        syncFullHistory: false,
        fireInitQueries: true,
        keepAliveIntervalMs: 30_000,
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 120_000,
        emitOwnEvents: true,
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        getMessage: async () => ({}),
      });

      session.socket = socket;

      if (session.reconnectTimer) clearTimeout(session.reconnectTimer);

      socket.ev.on("creds.update", async () => {
        try {
          await saveCreds();
          setTimeout(backupCreds, 1000);
        } catch (err) {
          console.error(`❌ Failed to save creds for ${key}:`, err?.message || err);
        }
      });

      const updateLastActive = () => {
        if (this.sessions[key]) this.sessions[key].lastActive = Date.now();
      };

      socket.ev.on("connection.update", async (update) => {
        const { connection, qr, lastDisconnect } = update;
        updateLastActive();

        if (qr) {
          const now = Date.now();
          if (now - (session.lastQRUpdate || 0) >= 60_000) {
            session.lastQRUpdate = now;
            try {
              await qrcode.toFile(path.join(sessionPath, "qr.png"), qr, {
                margin: 2,
                scale: 8,
                color: { dark: "#000000", light: "#FFFFFF" },
              });
              const qrUrl = `/asset/sessions/${key}/qr.png?t=${Date.now()}`;
              session.qr = qrUrl;
              this.io.emit("qr-update", { key, qr: qrUrl });
              console.log(`✅ QR Code generated for ${key}`);
            } catch (err) {
              console.error(`❌ QR Generate Error for ${key}:`, err?.message || err);
            }
          }
        }

        if (connection === "open") {
          console.log(`✅ Connected: ${key}`);
          session.connected = true;
          session.qr = null;
          session.reconnectCount = 0;
          session.creating = false;
          this.io.emit("connection-status", { key, connected: true });

          try {
            if (socket.user?.id) {
              const phoneText = socket.user.id.split("@")[0].split(":")[0];
              await this.deviceManager.updateDeviceStatus(key, "connected", phoneText, socket.user.name || "Unknown");
            } else await this.deviceManager.updateDeviceStatus(key, "connected");
          } catch (err) {
            console.error(`❌ Failed to update device status for ${key}:`, err?.message || err);
          }
        }

        if (connection === "close") {
          session.connected = false;
          this.io.emit("connection-status", { key, connected: false });
          let reason = "unknown";

          if (lastDisconnect?.error) {
            const error = lastDisconnect.error;
            reason = error.output?.statusCode || "unknown";
            if (reason === DisconnectReason.loggedOut) {
              console.log(`🚨 Session logged out: ${key} - PERMANENT DISCONNECT`);
              await this.deviceManager.updateDeviceStatus(key, "logout").catch(console.error);
              this.removeSession(key, false);
              return;
            }
          }

          console.log(`🔌 Session ${key} disconnected (reason: ${reason})`);
          session.reconnectCount = (session.reconnectCount || 0) + 1;
          const delay = Math.min(30_000, 5000 * Math.pow(2, session.reconnectCount)) + Math.random() * 30_000;

          if (!session.reconnecting) {
            session.reconnecting = true;
            setTimeout(() => {
              this.createSession(key).finally(() => (session.reconnecting = false));
            }, delay);
          }
        }
      });

      if (session.heartbeat) clearInterval(session.heartbeat);
      session.heartbeat = setInterval(() => {
        if (session.socket?.ws?.readyState !== 1) {
          console.log(`💔 Heartbeat failed for ${key} - forcing reconnect`);
          clearInterval(session.heartbeat);
          session.heartbeat = null;
          try {
            if (session.socket?.end) session.socket.end(new Error("Heartbeat timeout"));
          } catch {}
        } else {
          session.lastActive = Date.now();
        }
      }, 60_000);

      session.creating = false;
    } catch (error) {
      session.creating = false;
      console.error(`❌ Session Error (${key}):`, error?.message || error);

      session.lastError = error?.message || String(error);
      await this.deviceManager.updateDeviceStatus(key, "error").catch(console.error);

      // Retry with exponential backoff
      const sessionRef = this.sessions[key];
      if (!sessionRef.permanentRemoved) {
        sessionRef.reconnectCount = (sessionRef.reconnectCount || 0) + 1;
        const delay = Math.min(30_000, 5000 * Math.pow(2, sessionRef.reconnectCount)) + Math.random() * 10_000;
        if (sessionRef.reconnectTimer) clearTimeout(sessionRef.reconnectTimer);
        sessionRef.reconnectTimer = setTimeout(() => this.createSession(key).catch(console.error), delay);
      }
    }
  }

  setupMessageHandlers(socket, key) {
    // minimal: copy dari kode lama
  }

  removeSession(key, deleteFolder = false) {
    const session = this.sessions[key];
    if (!session || session.removing) return;
    session.removing = true;

    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    if (session.heartbeat) clearInterval(session.heartbeat);
    if (session.backupInterval) clearInterval(session.backupInterval);

    if (session.socket) {
      try {
        session.socket.logout?.().catch(() => {});
        session.socket.end?.(new Error("Manual removal"));
        session.socket.close?.();
      } catch {}
    }

    delete this.sessions[key];
    delete this.reconnectDelays[key];

    if (deleteFolder) {
      const sessionPath = path.join(this.folderSession, key);
      if (fs.existsSync(sessionPath)) {
        try {
          fs.rmSync(sessionPath, { recursive: true, force: true });
        } catch {}
      }
    }
  }

  getSession(key) {
    return this.sessions[key];
  }

  getAllSessions() {
    return this.sessions;
  }

  async checkSessionHealth(key) {
    const session = this.sessions[key];
    if (!session || !session.socket) return { healthy: false, reason: "No active socket" };
    if (!session.connected) return { healthy: false, reason: "Not connected" };
    if (Date.now() - session.lastActive > 300_000) return { healthy: false, reason: "Inactive for too long" };
    return { healthy: true, lastActive: session.lastActive };
  }

  async forceReconnect(key) {
    console.log(`🔄 Force reconnecting session: ${key}`);
    if (this.sessions[key]) this.removeSession(key, false);
    await this.createSession(key);
  }
}

module.exports = SessionManager;
