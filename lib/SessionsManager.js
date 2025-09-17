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
const { DeviceManager } = require("../lib/DeviceManager");

class SessionManager {
  constructor(pool, io, deviceManager, folderSession = "../.sessions") {
    this.pool = pool;
    this.io = io;
    this.folderSession = folderSession;
    this.sessions = {};
    this.deviceManager = deviceManager;

    if (!fs.existsSync(this.folderSession)) {
      fs.mkdirSync(this.folderSession, { recursive: true });
      fs.chmodSync(this.folderSession, 0o750);
    }
  }

  async initSessions() {
    console.log("Initializing sessions...");
    const sessionKeys = fs
      .readdirSync(this.folderSession)
      .filter((file) =>
        fs.statSync(path.join(this.folderSession, file)).isDirectory()
      );

    await Promise.all(
      sessionKeys.map(async (key) => {
        const sessionPath = path.join(this.folderSession, key);
        try {
          await fs.promises.access(path.join(sessionPath, "creds.json"));
          await this.createSession(key);
        } catch (error) {
          console.log(`Removing corrupt session: ${key}`);
          fs.rm(sessionPath, { recursive: true, force: true }, (rmError) => {
            if (rmError)
              console.log(`Failed to remove corrupt session: ${key}`);
            else console.log(`Successfully removed corrupt session: ${key}`);
          });
        }
      })
    );

    console.log("All sessions initialized!");
  }

  async createSession(key) {
    try {
      const sessionPath = path.join(this.folderSession, key);
      if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
        fs.chmodSync(sessionPath, 0o750);
      }

      if (!this.sessions[key]) {
        this.sessions[key] = {
          socket: null,
          qr: null,
          connected: false,
          reconnectCount: 0,
        };
      }
      const session = this.sessions[key];

      if (session.socket && session.socket.close) session.socket.close();

      const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

      const socket = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: Browsers.ubuntu("Chrome"),
        markOnlineOnConnect: true,
        syncFullHistory: false,
        fireInitQueries: true,
        keepAliveIntervalMs: 20000,
        connectTimeoutMs: 30000,
        defaultQueryTimeoutMs: 60000,
        getMessage: async () => ({}),
      });

      session.socket = socket;

      socket.ev.on("creds.update", saveCreds);

      // Backup creds setiap 5 menit
      setInterval(() => {
        try {
          const src = path.join(sessionPath, "creds.json");
          const dst = path.join(sessionPath, "creds.backup.json");
          if (fs.existsSync(src)) fs.copyFileSync(src, dst);
        } catch (err) {
          console.error(`Failed to backup creds for ${key}:`, err.message);
        }
      }, 5 * 60 * 1000);

      // Heartbeat cek koneksi
      session.heartbeat = setInterval(() => {
        if (!session.connected) return;
        if (socket.ws?.readyState !== 1) {
          console.log(`Heartbeat fail: ${key}, forcing reconnect`);
          socket.ws.close();
        }
      }, 60000);

      socket.ev.on("connection.update", async (update) => {
        const { connection, qr, lastDisconnect } = update;
        const statusMap = {
          open: "connected",
          close: "disconnected",
          connecting: "connecting",
        };

        if (statusMap[connection]) {
          try {
            const userJid = socket.user.id;
            const pushName = socket.user.name || "Unknown";
            const phoneNumber = userJid.split("@")[0].split(":")[0];
            await this.deviceManager.updateDeviceStatus(
              key,
              statusMap[connection],
              phoneNumber,
              pushName
            );
          } catch (err) {
            console.error(
              `Failed to update device status for ${key}:`,
              err.message
            );
          }
        }

        if (
          qr &&
          (!session.lastQRUpdate || Date.now() - session.lastQRUpdate > 30000)
        ) {
          session.lastQRUpdate = Date.now();
          qrcode.toFile(path.join(sessionPath, "qr.png"), qr, (err) => {
            if (!err) {
              const qrUrl = `/asset/sessions/${key}/qr.png?t=${Date.now()}`;
              session.qr = qrUrl;
              this.io.emit("qr-update", { key, qr: qrUrl });
            } else console.error(`QR Generate Error for ${key}:`, err.message);
          });
        }

        if (connection === "open") {
          session.connected = true;
          session.qr = null;
          session.reconnectCount = 0;
          this.io.emit("connection-status", { key, connected: true });

          socket.ev.on("messages.upsert", async ({ messages, type }) => {
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

              // Handle /register
              if (remoteJid.endsWith("@g.us") && lowerMessage === "/register") {
                console.log(`Register command from ${sender} in ${remoteJid}`);
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
                    "SELECT id FROM `groups` WHERE group_id=? AND device_key=?",
                    [remoteJid, device_key]
                  );
                  if (existing.length === 0) {
                    const group_key = generateGroupID();
                    await this.pool.query(
                      "INSERT INTO `groups` (group_id, group_key, name, device_key, registered_at) VALUES (?, ?, ?, ?, ?)",
                      [remoteJid, group_key, groupName, device_key, new Date()]
                    );
                    await socket.sendMessage(remoteJid, {
                      text: `Grup/Channel berhasil terdaftar: *${group_key}*`,
                    });
                  } else {
                    await socket.sendMessage(remoteJid, {
                      text: `Grup/Channel sudah terdaftar`,
                    });
                  }
                } catch (err) {
                  console.error("Error registrasi grup:", err.message);
                }
                continue;
              }

              // Handle /unregister
              if (
                remoteJid.endsWith("@g.us") &&
                lowerMessage === "/unregister"
              ) {
                console.log(
                  `Unregister command from ${sender} in ${remoteJid}`
                );
                try {
                  const [existing] = await this.pool.query(
                    "SELECT id FROM `groups` WHERE group_id=? AND device_key=?",
                    [remoteJid, device_key]
                  );
                  if (existing.length > 0) {
                    await this.pool.query(
                      "DELETE FROM `groups` WHERE group_id=? AND device_key=?",
                      [remoteJid, device_key]
                    );
                    await socket.sendMessage(remoteJid, {
                      text: `Grup/Channel telah berhasil *diunregister*.`,
                    });
                  } else {
                    await socket.sendMessage(remoteJid, {
                      text: `Grup/Channel ini belum terdaftar.`,
                    });
                  }
                } catch (err) {
                  console.error("Error unregister grup:", err.message);
                }
                continue;
              }

              // Auto-reply
              try {
                const [rows] = await this.pool.query(
                  "SELECT response FROM autoreply WHERE keyword=?",
                  [lowerMessage]
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
          });
        }

        if (connection === "close") {
          session.connected = false;
          this.io.emit("connection-status", { key, connected: false });

          if (lastDisconnect?.error) {
            const isLoggedOut =
              lastDisconnect.error.output?.statusCode ===
              DisconnectReason.loggedOut;
            if (isLoggedOut) {
              console.log(`Session logged out: ${key}`);
              this.removeSession(key, true);
            } else {
              if (!session.reconnecting) {
                session.reconnecting = true;
                const delay = Math.min(
                  30000,
                  5000 * Math.pow(2, session.reconnectCount)
                );
                session.reconnectCount++;
                setTimeout(() => {
                  this.createSession(key).finally(
                    () => (session.reconnecting = false)
                  );
                }, delay);
              }
            }
          }
        }
      });

      socket.ev.on("ws.connection", (update) => {
        if (update.error)
          console.error(`WS Error (${key}):`, update.error.message);
      });
    } catch (error) {
      console.error(`Session Error (${key}):`, error.message);
      if (this.sessions[key]) this.removeSession(key, true);
    }
  }

  removeSession(key, deleteFolder = false) {
    const session = this.sessions[key];
    if (!session) return;

    if (session.socket?.ws) {
      try {
        session.socket.ws.close();
      } catch {}
    }

    clearInterval(session.heartbeat);

    delete this.sessions[key];

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
}

module.exports = SessionManager;
