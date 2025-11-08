const path = require("path");
const fs = require("fs");
const qrcode = require("qrcode");
const { Boom } = require("@hapi/boom");
const {
  Browsers,
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const pino = require("pino");

const crypto = require("crypto");
const axios = require("axios");

const moment = require("moment-timezone");
const {
  generateAPIKey,
  generateDeviceID,
  generateGroupID,
} = require("../lib/Generate");
const { calculateLastActive } = require("../lib/Utils");
const { DeviceManager } = require("../lib/DeviceManager");

class SessionManager {
  constructor(pool, io, deviceManager, folderSession = "../.sessions") {
    this.pool = pool;
    this.io = io;
    this.folderSession = folderSession;
    this.sessions = {};

    if (!fs.existsSync(this.folderSession)) {
      fs.mkdirSync(this.folderSession, { recursive: true });
      fs.chmodSync(this.folderSession, 0o755);
    }

    this.deviceManager = deviceManager;
  }

  async initSessions() {
    console.log("Initializing sessions...");
    const sessionKeys = fs.readdirSync(this.folderSession).filter((file) => {
      return fs.statSync(path.join(this.folderSession, file)).isDirectory();
    });

    await Promise.all(
      sessionKeys.map(async (key) => {
        const sessionPath = path.join(this.folderSession, key);
        try {
          await fs.promises.access(path.join(sessionPath, "creds.json"));
          await this.createSession(key);
        } catch (error) {
          if (error) {
            console.log(`Removing corrupt session: ${key}`);
            fs.rm(sessionPath, { recursive: true, force: true }, (rmError) => {
              if (rmError) {
                console.log(`Failed to remove corrupt session: ${key}`);
              } else {
                console.log(`Successfully removed corrupt session: ${key}`);
              }
            });
          } else {
            console.log(`Unknown error session: ${key} => ${error}`);
          }
        }
      })
    );
    console.log("All sessions initialized!");
  }

  async createSession(key) {
    let session;
    try {
      const sessionPath = path.join(this.folderSession, key);

      // Pastikan folder utama ada sebelum membuat subfolder
      if (!fs.existsSync(this.folderSession)) {
        fs.mkdirSync(this.folderSession, { recursive: true });
        fs.chmodSync(this.folderSession, 0o755);
      }

      // Pastikan subfolder session ada
      if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
        fs.chmodSync(sessionPath, 0o755);
      }

      if (!this.sessions[key]) {
        this.sessions[key] = {
          socket: null,
          qr: null,
          connected: false,
        };
      }

      session = this.sessions[key];
      if (session.socket && typeof session.socket.close === "function") {
        session.socket.close();
      }

      const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
      const { version } = await fetchLatestBaileysVersion();
      const socket = makeWASocket({
        version,
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

      socket.ev.on("creds.update", saveCreds);

      socket.ev.on("connection.update", async (update) => {
        const { connection, qr, lastDisconnect } = update;

        const statusMap = {
          open: "connected",
          close: "disconnected",
          connecting: "connecting",
        };

        if (statusMap[connection]) {
          try {
            if (socket.user) {
              const userJid = socket.user.id;
              const pushName = socket.user.name || "Unknown";
              const phoneText = userJid.split("@")[0];
              const phoneNumber = phoneText.split(":")[0];

              await this.deviceManager.updateDeviceStatus(
                key,
                statusMap[connection],
                phoneNumber,
                pushName
              );
            }
          } catch (error) {
            console.error(
              `Failed to update device status for ${key}:`,
              error.message
            );
          }
        }

        if (qr) {
          console.log(`QR Code received for ${key}`);
          const now = Date.now();

          if (now - (session.lastQRUpdate || 0) < 5000) {
            console.log(`Skipping QR update for ${key} (too frequent)`);
            return;
          }

          session.lastQRUpdate = now;

          qrcode.toFile(path.join(sessionPath, "qr.png"), qr, (err) => {
            if (err) {
              console.error(`QR Generate Error for ${key}:`, err.message);
              return;
            }

            const timestamp = Date.now();
            const qrUrl = `/asset/sessions/${key}/qr.png?t=${timestamp}`;
            session.qr = qrUrl;
            this.io.emit("qr-update", { key, qr: qrUrl });
          });
        }

        if (connection === "open") {
          console.log(`Connected: ${key}`);
          session.connected = true;
          session.qr = null;
          this.io.emit("connection-status", { key, connected: true });

          socket.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify" || !messages || messages.length === 0) return;

            for (const msg of messages) {
              // Pastikan device_key dari sumber valid atau default 0
              const device_key = typeof key !== "undefined" ? key : 0;

              const remoteJid = msg.key?.remoteJid || ""; // bisa grup atau personal
              const sender = msg.pushName || "Unknown";

              const messageContent =
                msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.imageMessage?.caption ||
                "";

              if (
                typeof messageContent !== "string" ||
                messageContent.trim() === ""
              )
                continue;

              const lowerMessage = messageContent.trim().toLowerCase();

              // Handle perintah /register di grup
              if (remoteJid.endsWith("@g.us") && lowerMessage === "/register") {
                console.log(
                  `Ditemukan pesan /register dari ${sender} di grup ${remoteJid}`
                );

                try {
                  const groupMetadata =
                    await session.socket.groupFetchAllParticipating();
                  const groups = Object.values(groupMetadata).map((group) => ({
                    id: group.id,
                    name: group.subject,
                  }));

                  const matchedGroup = groups.find(
                    (group) => group.id === remoteJid
                  );
                  const groupName = matchedGroup?.name || "Unknown Group";
                  const timestamp = new Date();

                  const [existing] = await this.pool.query(
                    "SELECT id FROM `groups` WHERE group_id = ? AND device_key = ?",
                    [remoteJid, device_key]
                  );

                  if (existing.length === 0) {
                    const group_key = generateGroupID();
                    await this.pool.query(
                      "INSERT INTO `groups` (group_id, group_key, name, device_key, registered_at) VALUES (?, ?, ?, ?, ?)",
                      [remoteJid, group_key, groupName, device_key, timestamp]
                    );

                    await session.socket.sendMessage(remoteJid, {
                      text: `Grup/Channel berhasil terdaftar: *${group_key}*`,
                    });

                    console.log(`Inserted group: ${groupName}`);
                  } else {
                    await session.socket.sendMessage(remoteJid, {
                      text: `Grup/Channel sudah terdaftar`,
                    });
                    console.log(`Group already exists in DB: ${groupName}`);
                  }
                } catch (err) {
                  console.error("Error saat registrasi grup:", err.message);
                }

                continue; // lanjut ke pesan berikutnya
              }

              // Handle perintah /unregister di grup
              if (
                remoteJid.endsWith("@g.us") &&
                lowerMessage === "/unregister"
              ) {
                console.log(
                  `Ditemukan pesan /unregister dari ${sender} di grup ${remoteJid}`
                );

                try {
                  const [existing] = await this.pool.query(
                    "SELECT id FROM `groups` WHERE group_id = ? AND device_key = ?",
                    [remoteJid, device_key]
                  );

                  if (existing.length > 0) {
                    await this.pool.query(
                      "DELETE FROM `groups` WHERE group_id = ? AND device_key = ?",
                      [remoteJid, device_key]
                    );

                    await session.socket.sendMessage(remoteJid, {
                      text: `Grup/Channel telah berhasil *diunregister*.`,
                    });

                    console.log(
                      `Group ${remoteJid} telah dihapus dari database`
                    );
                  } else {
                    await session.socket.sendMessage(remoteJid, {
                      text: `Grup/Channel ini belum terdaftar.`,
                    });
                    console.log(`Unregister gagal: grup tidak ditemukan di DB`);
                  }
                } catch (err) {
                  console.error("Error saat unregister grup:", err.message);
                }

                continue; // lanjut ke pesan berikutnya
              }

              // Auto-reply untuk grup dan personal
              try {
                if (lowerMessage) {
                  const [rows] = await this.pool.query(
                    "SELECT response FROM autoreply WHERE keyword = ?",
                    [lowerMessage]
                  );

                  if (rows.length > 0) {
                    const reply = rows[0].response;

                    await session.socket.sendMessage(remoteJid, {
                      text: reply,
                    });

                    console.log(
                      `Auto-reply sent to ${sender} in chat ${remoteJid}`
                    );
                  } else {
                    console.log(
                      `No auto-reply found for message: "${lowerMessage}"`
                    );
                  }
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
            const error = lastDisconnect.error;
            const isLoggedOut =
              error.output?.statusCode === DisconnectReason.loggedOut;

            if (isLoggedOut) {
              console.log(`Session logged out: ${key}`);
              this.removeSession(key, false);
            } else {
              console.log(`Reconnecting: ${key}`);
              if (!session.reconnecting) {
                session.reconnecting = true;
                setTimeout(() => {
                  this.createSession(key).finally(
                    () => (session.reconnecting = false)
                  );
                }, 5000);
              }
            }
          }
        }
      });

      socket.ev.on("ws.connection", (update) => {
        if (update.error) {
          console.error(`WS Error (${key}):`, update.error.message);
        }
      });
    } catch (error) {
      console.error(`Session Error (${key}):`, error.message);

      if (this.sessions[key]) {
        this.removeSession(key, false);

        try {
          await this.deviceManager.updateDeviceStatus(key, "removed");
        } catch (updateError) {
          console.error(
            `Failed to update device status for ${key}:`,
            updateError.message
          );
        }
      } else {
        try {
          await this.deviceManager.updateDeviceStatus(key, "error");
        } catch (updateError) {
          console.error(
            `Failed to update device status for ${key}:`,
            updateError.message
          );
        }
      }
    }
  }

  removeSession(key, deleteFolder = false) {
    const session = this.sessions[key];
    if (!session) return;
    if (session.socket && typeof session.socket.ws.close === "function") {
      session.socket.ws.close();
    }
    delete this.sessions[key];
    if (deleteFolder) {
      const sessionPath = path.join(this.folderSession, key);
      if (fs.existsSync(sessionPath)) {
        console.log(`Attempting to remove session folder: ${sessionPath}`);
        try {
          fs.rmSync(sessionPath, { recursive: true, force: true });
          console.log(`Successfully removed session folder: ${sessionPath}`);
        } catch (rmError) {
          console.log(`Failed to remove session folder: ${sessionPath}`);
        }
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
