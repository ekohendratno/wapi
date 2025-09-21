// SessionManager.js — Versi Final yang Stabil & Cepat Generate QR

const path = require("path");
const fs = require("fs");
const qrcode = require("qrcode");
const {
  Browsers,
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");
const pino = require("pino");

const { generateGroupID } = require("../lib/Generate");

class SessionManager {
  constructor(pool, io, deviceManager, folderSession = "../.sessions") {
    this.pool = pool;
    this.io = io;
    this.folderSession = folderSession;
    this.sessions = {};
    this.deviceManager = deviceManager;

    // Ensure base folder exists
    if (!fs.existsSync(this.folderSession)) {
      fs.mkdirSync(this.folderSession, { recursive: true });
    }

    // Global safety nets
    if (!SessionManager._globalHandlersRegistered) {
      SessionManager._globalHandlersRegistered = true;
      process.on("uncaughtException", (err) => {
        console.error("Uncaught Exception:", err.stack || err);
      });
      process.on("unhandledRejection", (reason) => {
        console.error("Unhandled Rejection:", reason);
      });
    }
  }

  // ✅ Helper: Buat folder + creds dummy jika belum ada — TANPA RETURN ERROR
  async ensureSessionFolder(key) {
    const sessionPath = path.join(this.folderSession, key);

    // Buat folder dasar
    if (!fs.existsSync(this.folderSession)) {
      fs.mkdirSync(this.folderSession, { recursive: true });
    }

    // Buat folder session
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
      console.log(`📁 Created session folder: ${sessionPath}`);
    }
  }

  async initSessions() {
    console.log("Initializing sessions...");
    const sessionKeys = fs.readdirSync(this.folderSession).filter((file) => {
      return fs.statSync(path.join(this.folderSession, file)).isDirectory();
    });

    for (const key of sessionKeys) {
      setTimeout(() => {
        this.createSession(key).catch((err) => {
          console.error(`createSession(${key}) failed:`, err.message);
        });
      }, Math.random() * 2000);
    }

    console.log("All sessions initialization enqueued.");
  }

  async createSession(key) {
    // Initialize session meta
    if (!this.sessions[key]) {
      this.sessions[key] = {
        socket: null,
        qr: null,
        connected: false,
        reconnecting: false,
        lastQRUpdate: 0,
      };
    }

    const session = this.sessions[key];
    const sessionPath = path.join(this.folderSession, key);

    // Prevent double-create
    if (session.creating) {
      console.log(`⏳ createSession already running for ${key}, skipping`);
      return;
    }
    session.creating = true;

    try {
      // ✅ BARU: Pastikan folder dan creds ada — BUAT OTOMATIS tanpa return error
      await this.ensureSessionFolder(key);

      // Close old socket
      if (session.socket) {
        try {
          if (typeof session.socket.logout === "function") {
            await session.socket.logout().catch(() => {});
          } else if (typeof session.socket.close === "function") {
            session.socket.close();
          }
        } catch (e) {
          console.warn(`⚠️ failed to close old socket for ${key}:`, e.message);
        }
        session.socket = null;
      }

      // Load auth state
      const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

      // Create socket
      const socket = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: Browsers.ubuntu("Chrome"),
        markOnlineOnConnect: true,
        syncFullHistory: false,
        fireInitQueries: true,
        keepAliveIntervalMs: 30000,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        getMessage: async () => ({}),
        shouldSyncHistoryMessage: () => false,
        shouldIgnoreJid: (jid) =>
          jid.endsWith("@broadcast") || jid === "status@broadcast",
      });

      session.socket = socket;

      // Save creds
      socket.ev.on("creds.update", async () => {
        try {
          await saveCreds();
          // Backup
          try {
            const src = path.join(sessionPath, "creds.json");
            const dst = path.join(sessionPath, "creds.backup.json");
            if (fs.existsSync(src)) fs.copyFileSync(src, dst);
          } catch (e) {
            console.error(`Backup creds gagal:`, e.message);
          }
        } catch (e) {
          console.error(`saveCreds failed for ${key}:`, e.message);
        }
      });

      // Connection update
      socket.ev.on("connection.update", async (update) => {
        const { connection, qr, lastDisconnect } = update;

        // QR generation
        if (qr && Date.now() - (session.lastQRUpdate || 0) > 30_000) {
          session.lastQRUpdate = Date.now();
          console.log(`[QR] Received new QR for ${key}`); // ✅ LOG INI HARUS MUNCUL

          try {
            await qrcode.toFile(path.join(sessionPath, "qr.png"), qr, {
              margin: 2,
              scale: 8,
            });
            const qrUrl = `/asset/sessions/${key}/qr.png?t=${Date.now()}`;
            session.qr = qrUrl;
            this.io.emit("qr-update", { key, qr: qrUrl });
            console.log(`[QR] QR Code saved and emitted for ${key}`);
          } catch (e) {
            console.error(`QR generate error for ${key}:`, e.message);
          }
        }

        // Handle open
        if (connection === "open") {
          session.connected = true;
          session.qr = null;
          this.io.emit("connection-status", { key, connected: true });

          // Update device status
          try {
            if (socket.user?.id) {
              const phoneText = socket.user.id.split("@")[0].split(":")[0];
              await this.deviceManager.updateDeviceStatus(
                key,
                "connected",
                phoneText,
                socket.user.name || "Unknown"
              );
            } else {
              await this.deviceManager.updateDeviceStatus(key, "connected");
            }
          } catch (e) {
            console.error(
              `Failed to update device status for ${key}:`,
              e.message
            );
          }

          // Attach messages.upsert
          socket.ev.on("messages.upsert", async ({ messages, type }) => {
            try {
              if (type !== "notify" || !messages) return;

              for (const msg of messages) {
                const device_key = key;
                const remoteJid = msg.key?.remoteJid || "";
                const sender = msg.pushName || "Unknown";
                const messageContent =
                  msg.message?.conversation ||
                  msg.message?.extendedTextMessage?.text ||
                  msg.message?.imageMessage?.caption ||
                  "";

                if (!messageContent.trim()) continue;

                const lowerMessage = messageContent.trim().toLowerCase();

                /** Handle /register */
                if (
                  remoteJid.endsWith("@g.us") &&
                  lowerMessage === "/register"
                ) {
                  console.log(
                    `Register command from ${sender} in ${remoteJid}`
                  );
                  try {
                    const groupMetadata =
                      await socket.groupFetchAllParticipating();
                    const groups = Object.values(groupMetadata).map((g) => ({
                      id: g.id,
                      name: g.subject,
                    }));
                    const matchedGroup = groups.find((g) => g.id === remoteJid);
                    const groupName = matchedGroup?.name || "Unknown Group";

                    const [existing] = await this.pool.query(
                      "SELECT id FROM groups WHERE group_id=? AND device_key=?",
                      [remoteJid, device_key]
                    );

                    if (existing.length === 0) {
                      const group_key = generateGroupID();
                      await this.pool.query(
                        "INSERT INTO groups (group_id, group_key, name, device_key, registered_at) VALUES (?, ?, ?, ?, ?)",
                        [
                          remoteJid,
                          group_key,
                          groupName,
                          device_key,
                          new Date(),
                        ]
                      );

                      await socket.sendMessage(remoteJid, {
                        text: `Grup/Channel berhasil terdaftar: *${group_key}*`,
                      });
                    } else {
                      await socket.sendMessage(remoteJid, {
                        text: "Grup/Channel sudah terdaftar",
                      });
                    }
                  } catch (err) {
                    console.error("Error registrasi grup:", err.message);
                  }
                  continue;
                }

                /** Handle /unregister */
                if (
                  remoteJid.endsWith("@g.us") &&
                  lowerMessage === "/unregister"
                ) {
                  console.log(
                    `Unregister command from ${sender} in ${remoteJid}`
                  );
                  try {
                    const [existing] = await this.pool.query(
                      "SELECT id FROM groups WHERE group_id=? AND device_key=?",
                      [remoteJid, device_key]
                    );

                    if (existing.length > 0) {
                      await this.pool.query(
                        "DELETE FROM groups WHERE group_id=? AND device_key=?",
                        [remoteJid, device_key]
                      );
                      await socket.sendMessage(remoteJid, {
                        text: "Grup/Channel telah berhasil *diunregister*.",
                      });
                    } else {
                      await socket.sendMessage(remoteJid, {
                        text: "Grup/Channel ini belum terdaftar.",
                      });
                    }
                  } catch (err) {
                    console.error("Error unregister grup:", err.message);
                  }
                  continue;
                }

                /** Auto-reply */
                try {
                  const chatType = remoteJid.endsWith("@g.us")
                    ? "group"
                    : "personal";

                  const [rows] = await this.pool.query(
                    `SELECT response FROM autoreply 
                     WHERE keyword=? 
                       AND device_id=(SELECT id FROM devices WHERE device_key=?) 
                       AND status='active' 
                       AND ( 
                         (is_for_group=1 AND ?='group') OR 
                         (is_for_personal=1 AND ?='personal') 
                       ) 
                     LIMIT 1`,
                    [lowerMessage, device_key, chatType, chatType]
                  );

                  if (rows.length > 0) {
                    await socket.sendMessage(remoteJid, {
                      text: rows[0].response,
                    });
                  }
                } catch (err) {
                  console.error("Autoreply error:", err.message);
                }
              }
            } catch (err) {
              console.error("messages.upsert error:", err.message);
            }
          });
        }

        // Handle close
        if (connection === "close") {
          session.connected = false;
          this.io.emit("connection-status", { key, connected: false });

          const err = lastDisconnect?.error;
          const loggedOut =
            err && err.output?.statusCode === DisconnectReason.loggedOut;

          if (loggedOut) {
            console.log(`🔐 Session ${key} LOGGED OUT — removing`);
            this.removeSession(key, true);
            return;
          }

          // Reconnect
          if (!session.reconnecting) {
            session.reconnecting = true;
            setTimeout(() => {
              this.createSession(key).finally(() => {
                session.reconnecting = false;
              });
            }, 5000);
          }
        }
      });

      // Done
      session.creating = false;
      console.log(`✅ Session ${key} started successfully`);
    } catch (err) {
      session.creating = false;
      console.error(`Session Error (${key}):`, err.message);

      try {
        await this.deviceManager.updateDeviceStatus(key, "error");
      } catch (e) {
        console.error(`Failed to update device status:`, e.message);
      }

      // Retry
      setTimeout(() => {
        this.createSession(key).catch(console.error);
      }, 5000);
    }
  }

  removeSession(key, deleteFolder = false) {
    const session = this.sessions[key];
    if (!session) return;

    if (session.socket) {
      try {
        session.socket.logout?.().catch(() => {});
      } catch {}
      try {
        session.socket.ws?.close?.();
      } catch {}
      try {
        session.socket.close?.();
      } catch {}
      session.socket = null;
    }

    delete this.sessions[key];

    if (deleteFolder) {
      const sessionPath = path.join(this.folderSession, key);
      try {
        if (fs.existsSync(sessionPath))
          fs.rmSync(sessionPath, { recursive: true, force: true });
      } catch (e) {
        console.warn(`Failed to remove session folder:`, e.message);
      }
    }

    console.log(`🗑️ Session ${key} removed`);
  }

  getSession(key) {
    return this.sessions[key] || null;
  }

  getAllSessions() {
    return { ...this.sessions };
  }

  async forceReconnect(key) {
    console.log(`🔄 Force reconnecting session: ${key}`);
    if (this.sessions[key]) {
      this.removeSession(key, false);
    }
    await this.createSession(key);
  }
}

module.exports = SessionManager;
