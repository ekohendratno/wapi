const path = require("path");
const fs = require("fs");
const qrcode = require("qrcode");
const pino = require("pino");

const { generateGroupID } = require("./Generate");

class SessionManager {
  constructor(pool, io, deviceManager, folderSession = "./.sessions") {
    this.pool = pool;
    this.io = io;
    this.deviceManager = deviceManager;
    this.folderSession = folderSession;
    this.sessions = {};
    this.shuttingDown = false;
    this._baileys = null;
    // Minimum time between QR updates (ms) to make QR stable for scanning
    this.logger = pino({ level: "info" });

    // Initialize Autoreply Cache
    this.autoreplyCache = [];
    this.refreshAutoreplyCache(); // Start caching in background

    if (!fs.existsSync(this.folderSession)) {
      fs.mkdirSync(this.folderSession, { recursive: true });
    }
  }

  async refreshAutoreplyCache() {
    try {
      const [rows] = await this.pool.query(
        "SELECT * FROM autoreply WHERE status = 'active'"
      );
      this.autoreplyCache = rows;
      this.logger.info(`Updated autoreply cache: ${rows.length} active rules.`);
    } catch (error) {
      this.logger.error("Failed to refresh autoreply cache:", error);
    }
  }

  async initSessions() {
    try {
      const keys = fs.readdirSync(this.folderSession).filter((f) => {
        const p = path.join(this.folderSession, f);
        try {
          return fs.statSync(p).isDirectory();
        } catch (e) {
          return false;
        }
      });

      this.logger.info(`Found ${keys.length} sessions to initialize.`);

      // Parallel loading with concurrency limit
      const CONCURRENCY_LIMIT = 5;
      const chunkArray = (arr, size) => {
        return Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
          arr.slice(i * size, i * size + size)
        );
      };

      const chunks = chunkArray(keys, CONCURRENCY_LIMIT);

      for (const chunk of chunks) {
        await Promise.all(
          chunk.map(async (k) => {
            const sessionPath = path.join(this.folderSession, k);
            try {
              await fs.promises.access(path.join(sessionPath, "creds.json"));
              await this.createSession(k);
            } catch (err) {
              this.logger.warn(
                `initSessions: missing or inaccessible creds.json for session ${k} (path=${sessionPath}). Skipping session creation.`
              );
              try {
                if (this.deviceManager?.updateDeviceStatus) {
                  await this.deviceManager.updateDeviceStatus(k, "error");
                }
              } catch (e) {
                this.logger.warn(
                  `initSessions: failed to mark device ${k} as error: ${e.message}`
                );
              }
            }
          })
        );
      }
      this.logger.info("All sessions initialized.");
    } catch (err) {
      this.logger.error(`initSessions error: ${err.message}`);
    }
  }

  async createSession(key) {
    const sessionPath = path.join(this.folderSession, key);
    if (!fs.existsSync(this.folderSession))
      fs.mkdirSync(this.folderSession, { recursive: true });
    if (!fs.existsSync(sessionPath))
      fs.mkdirSync(sessionPath, { recursive: true });

    if (!this.sessions[key])
      this.sessions[key] = {
        socket: null,
        qr: null,
        connected: false,
        reconnecting: false,
        lastQRUpdate: 0,
        error: null,
        lastError: null,
      };
    const session = this.sessions[key];
    // reset any previous transient state when attempting to create
    session.error = null;
    session.lastError = null;
    session.qr = null;
    session.connected = false;
    session.lastQRUpdate = 0;

    // Ensure Baileys is imported dynamically (ESM) and cache exports on this._baileys
    let makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      fetchLatestBaileysVersion;
    try {
      if (!this._baileys) {
        this._baileys = await import("@whiskeysockets/baileys");
      }
      makeWASocket = this._baileys.default;
      useMultiFileAuthState = this._baileys.useMultiFileAuthState;
      DisconnectReason = this._baileys.DisconnectReason;
      fetchLatestBaileysVersion = this._baileys.fetchLatestBaileysVersion;
      // Extract Browsers if available, or fallback handled later
      var Browsers = this._baileys.Browsers;
    } catch (impErr) {
      this.logger.error(
        "Failed to import @whiskeysockets/baileys dynamically:",
        impErr && (impErr.message || impErr)
      );
      throw impErr;
    }

    try {
      if (session.socket) {
        if (session.socket.ws && typeof session.socket.ws.close === "function")
          session.socket.ws.close();
        else if (typeof session.socket.close === "function")
          await session.socket.close();
      }
    } catch (e) {}

    try {
      const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
      const { version } = await fetchLatestBaileysVersion();
      // Enable logging by setting level to 'info' or 'debug'
      const socket = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "info" }),
        // Use a realistic browser signature (Ubuntu is standard for server-side bots)
        browser: Browsers
          ? Browsers.ubuntu("Chrome")
          : ["Ubuntu", "Chrome", "20.0.04"],
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false, // Further minimize background activity for anti-ban
        markOnline: false, // Don't show as online unless interacting
        generateHighQualityLinkPreview: true, // More realistic link previews
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        retryRequestDelayMs: 250,
        getMessage: async () => ({}),
      });

      session.socket = socket;
      socket.ev.on("creds.update", saveCreds);

      socket.ev.on("connection.update", async (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) {
          const now = Date.now();
          if (now - (session.lastQRUpdate || 0) < this.QR_DEBOUNCE_MS) return;
          session.lastQRUpdate = now;
          try {
            await qrcode.toFile(path.join(sessionPath, "qr.png"), qr);
            session.qr = `/asset/sessions/${key}/qr.png?t=${Date.now()}`;
            session.error = null;
            session.lastError = null;
            this.io.emit("qr-update", { key, qr: session.qr });
          } catch (e) {
            /* ignore */
          }
        }

        if (connection === "open") {
          session.connected = true;
          session.qr = null;
          session.error = null;
          session.lastError = null;
          this.io.emit("connection-status", { key, connected: true });
          // update DB status to connected (best-effort)
          try {
            if (
              this.deviceManager &&
              typeof this.deviceManager.updateDeviceStatus === "function" &&
              socket.user
            ) {
              const userJid = socket.user.id || "";
              const phoneText = userJid.split("@")[0] || "";
              const phoneNumber = phoneText.split(":")[0] || null;
              const pushName = socket.user.name || null;
              await this.deviceManager.updateDeviceStatus(
                key,
                "connected",
                phoneNumber,
                pushName
              );
            }
          } catch (e) {
            this.logger.warn(
              `Failed to persist connected status for ${key}:`,
              e && e.message
            );
          }

          // Cache device_id for this session to scope autoreply lookups
          try {
            const [drows] = await this.pool.query(
              "SELECT id, uid FROM devices WHERE device_key = ? LIMIT 1",
              [key]
            );
            if (drows.length) {
              session.deviceId = drows[0].id;
              session.uid = drows[0].uid;
            } else {
              session.deviceId = null;
              session.uid = null;
            }
          } catch (e) {
            session.deviceId = null;
            session.uid = null;
            this.logger.warn(
              `Failed to resolve device info for ${key}:`,
              e && e.message
            );
          }

          socket.ev.on("messaging-history.set", ({ contacts }) => {
            if (contacts)
              this.upsertContacts(session.uid, session.deviceId, contacts);
          });

          socket.ev.on("contacts.set", (contacts) => {
            this.upsertContacts(session.uid, session.deviceId, contacts);
          });

          socket.ev.on("contacts.upsert", (contacts) => {
            this.upsertContacts(session.uid, session.deviceId, contacts);
          });

          socket.ev.on("contacts.update", (updates) => {
            this.upsertContacts(session.uid, session.deviceId, updates);
          });

          socket.ev.on("messages.upsert", async ({ messages, type }) => {
            if (this.shuttingDown) return;
            if (type !== "notify" || !messages || messages.length === 0) return;
            for (const msg of messages) {
              if (this.shuttingDown) break;
              const remoteJid = msg.key?.remoteJid || "";
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

              try {
                if (
                  remoteJid.endsWith("@g.us") &&
                  lowerMessage === "/register"
                ) {
                  const groupMetadata =
                    await session.socket.groupFetchAllParticipating();
                  const groups = Object.values(groupMetadata).map((g) => ({
                    id: g.id,
                    name: g.subject,
                  }));
                  const matched = groups.find((g) => g.id === remoteJid);
                  const groupName = matched?.name || "Unknown Group";
                  const [existing] = await this.pool.query(
                    "SELECT id FROM `groups` WHERE group_id = ? AND device_key = ?",
                    [remoteJid, key]
                  );
                  if (existing.length === 0) {
                    const group_key = generateGroupID();
                    await this.pool.query(
                      "INSERT INTO `groups` (group_id, group_key, name, device_key, registered_at) VALUES (?, ?, ?, ?, ?)",
                      [remoteJid, group_key, groupName, key, new Date()]
                    );
                    await session.socket.sendMessage(remoteJid, {
                      text: `Grup/Channel berhasil terdaftar: *${group_key}*`,
                    });
                  } else {
                    await session.socket.sendMessage(remoteJid, {
                      text: `Grup/Channel sudah terdaftar`,
                    });
                  }
                  continue;
                }

                // --- OPT-IN LOGIC ---
                if (
                  String(process.env.FEATURE_OPT_IN) === "1" &&
                  !remoteJid.endsWith("@g.us") &&
                  session.uid &&
                  session.deviceId
                ) {
                  let cleanNumber = remoteJid.split("@")[0];

                  // Try to resolve phone number if it's a LID or a reply using stanzaId (Reply logic)
                  const contextInfo =
                    msg.message?.extendedTextMessage?.contextInfo ||
                    msg.message?.imageMessage?.contextInfo ||
                    msg.message?.videoMessage?.contextInfo ||
                    msg.message?.documentMessage?.contextInfo;

                  const stanzaId = contextInfo?.stanzaId;

                  if (stanzaId) {
                    const [origMsg] = await this.pool.query(
                      "SELECT number FROM messages WHERE uid = ? AND device_id = ? AND response LIKE ?",
                      [session.uid, session.deviceId, `%${stanzaId}%`]
                    );
                    if (origMsg.length > 0) {
                      // Use the number we originally sent to
                      const resolvedNumber = origMsg[0].number
                        .split(",")[0]
                        .replace(/\D/g, "");
                      if (resolvedNumber) {
                        cleanNumber = resolvedNumber;
                        this.logger.info(
                          `Resolved JID ${remoteJid} to phone number ${cleanNumber} via stanzaId ${stanzaId}`
                        );
                      }
                    }
                  }

                  // --- NEW: LID Resolution via Contacts Table ---
                  if (remoteJid.includes("@lid")) {
                    const [contact] = await this.pool.query(
                      "SELECT phone, name FROM contacts WHERE uid = ? AND device_id = ? AND jid = ? LIMIT 1",
                      [session.uid, session.deviceId, remoteJid]
                    );

                    if (contact.length > 0) {
                      if (contact[0].phone) {
                        cleanNumber = contact[0].phone.replace(/\D/g, "");
                        this.logger.info(
                          `Resolved LID ${remoteJid} to phone number ${cleanNumber} via direct contact mapping`
                        );
                      } else if (contact[0].name) {
                        // Try fuzzy match by name if phone is missing for this LID
                        const [namedPN] = await this.pool.query(
                          "SELECT phone FROM contacts WHERE uid = ? AND device_id = ? AND name = ? AND phone IS NOT NULL LIMIT 1",
                          [session.uid, session.deviceId, contact[0].name]
                        );
                        if (namedPN.length > 0) {
                          cleanNumber = namedPN[0].phone.replace(/\D/g, "");
                          this.logger.info(
                            `Resolved LID ${remoteJid} to phone number ${cleanNumber} via name matching (${contact[0].name})`
                          );

                          // Update the LID contact record with the phone we found for future use
                          await this.pool.query(
                            "UPDATE contacts SET phone = ? WHERE jid = ? AND uid = ? AND device_id = ?",
                            [
                              cleanNumber,
                              remoteJid,
                              session.uid,
                              session.deviceId,
                            ]
                          );
                        }
                      }
                    }
                  }
                  // ----------------------------------------------

                  const optInKeywords = [
                    "setuju",
                    "saya setuju",
                    "aktifkan notifikasi",
                    "daftar notifikasi",
                  ];
                  const optOutKeywords = [
                    "stop",
                    "berhenti",
                    "tidak setuju",
                    "unsubs",
                    "blokir",
                  ];

                  if (
                    optOutKeywords.some(
                      (k) => lowerMessage === k || lowerMessage.includes(k)
                    )
                  ) {
                    await this.recordOptIn(
                      session.uid,
                      session.deviceId,
                      cleanNumber,
                      "blocked",
                      "chat_explicit"
                    );
                    await session.socket.sendMessage(remoteJid, {
                      text: "Anda telah berhenti berlangganan notifikasi. Kirim 'SETUJU' kapan saja untuk mengaktifkan kembali.",
                    });
                    continue;
                  } else if (
                    optInKeywords.some(
                      (k) => lowerMessage === k || lowerMessage.includes(k)
                    )
                  ) {
                    await this.recordOptIn(
                      session.uid,
                      session.deviceId,
                      cleanNumber,
                      "approved",
                      "chat_explicit"
                    );
                    await session.socket.sendMessage(remoteJid, {
                      text: "Terima kasih! Nomor Anda telah terdaftar untuk menerima notifikasi otomatis dari kami.",
                    });
                    continue;
                  } else {
                    // Regular message from unknown number also counts as implicit opt-in (first contact)
                    await this.recordOptIn(
                      session.uid,
                      session.deviceId,
                      cleanNumber,
                      "approved",
                      "chat_implicit"
                    );
                  }
                }
                // --- END OPT-IN LOGIC ---

                if (
                  remoteJid.endsWith("@g.us") &&
                  lowerMessage === "/unregister"
                ) {
                  const [existing] = await this.pool.query(
                    "SELECT id FROM `groups` WHERE group_id = ? AND device_key = ?",
                    [remoteJid, key]
                  );
                  if (existing.length > 0) {
                    await this.pool.query(
                      "DELETE FROM `groups` WHERE group_id = ? AND device_key = ?",
                      [remoteJid, key]
                    );
                    await session.socket.sendMessage(remoteJid, {
                      text: `Grup/Channel telah berhasil *diunregister*.`,
                    });
                  } else {
                    await session.socket.sendMessage(remoteJid, {
                      text: `Grup/Channel ini belum terdaftar.`,
                    });
                  }
                  continue;
                }

                // Scope autoreply to this device only. Prefer cached deviceId if available.
                // Scope autoreply to this device only. Prefer cached deviceId if available.
                let rows = [];
                try {
                  // Use cached autoreplies instead of DB query
                  if (this.autoreplyCache && this.autoreplyCache.length > 0) {
                    const matched = this.autoreplyCache.find(
                      (r) =>
                        r.keyword.toLowerCase() === lowerMessage &&
                        r.status === "active" &&
                        (session.deviceId
                          ? r.device_id === session.deviceId
                          : false) // Strict check on deviceId
                    );
                    if (matched) {
                      rows = [matched];
                    }
                  }

                  // Fallback or debug log if needed (omitted for performance)
                } catch (e) {
                  this.logger.error("autoreply lookup error:", e && e.message);
                }

                if (rows && rows.length > 0) {
                  // Simulate human behavior to avoid bans
                  try {
                    // 1. Mark message as read
                    if (typeof session.socket.readMessages === "function") {
                      await session.socket.readMessages([msg.key]);
                    }

                    // 2. Send "typing..." presence
                    await session.socket.sendPresenceUpdate(
                      "composing",
                      remoteJid
                    );

                    // 3. Random delay between 2 to 5 seconds
                    const delayMs = Math.floor(Math.random() * 3000) + 2000;
                    await new Promise((resolve) =>
                      setTimeout(resolve, delayMs)
                    );

                    // 4. Send the response
                    await session.socket.sendMessage(remoteJid, {
                      text: rows[0].response,
                    });

                    // 5. Stop typing
                    await session.socket.sendPresenceUpdate(
                      "paused",
                      remoteJid
                    );
                  } catch (sendErr) {
                    this.logger.error(
                      "Error sending autoreply with simulation:",
                      sendErr
                    );
                    // Fallback to direct send if simulation fails
                    await session.socket.sendMessage(remoteJid, {
                      text: rows[0].response,
                    });
                  }
                }
              } catch (err) {
                this.logger.error("message handler error:", err && err.message);
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
              // Mark session as error instead of removing it immediately.
              // This allows API to report "Device logged out" or similar instead of 500.
              session.error = true;
              session.lastError = "Device logged out by WhatsApp (loggedOut)";
              this.logger.warn(
                `Device ${key} logged out. Session marked as error.`
              );

              // Update DB status to disconnected so it doesn't show as connected
              try {
                if (
                  this.deviceManager &&
                  typeof this.deviceManager.updateDeviceStatus === "function"
                ) {
                  await this.deviceManager.updateDeviceStatus(
                    key,
                    "disconnected"
                  );
                }
              } catch (e) {
                this.logger.warn(
                  `Failed to update device status (loggedOut) for ${key}:`,
                  e && e.message
                );
              }

              // Only cleanup the socket, do NOT remove the session object from memory or disk automatically
              try {
                if (session.socket) {
                  if (
                    session.socket.ws &&
                    typeof session.socket.ws.close === "function"
                  )
                    session.socket.ws.close();
                  else if (typeof session.socket.close === "function")
                    await session.socket.close();
                }
              } catch (e) {}
              session.socket = null;
            } else if (!session.reconnecting) {
              session.reconnecting = true;
              setTimeout(() => {
                this.createSession(key).finally(() => {
                  session.reconnecting = false;
                });
              }, 5000);
            }
          }
        }
      });

      socket.ev.on("ws.connection", (update) => {
        if (update.error)
          this.logger.error(
            `WS Error (${key}):`,
            update.error && update.error.message
          );
      });
    } catch (error) {
      this.logger.error(
        `Session Error (${key}):`,
        error && (error.stack || error)
      );
      // Don't remove session folder automatically on error; mark device as 'error' so admin can inspect/restore
      try {
        if (
          this.deviceManager &&
          typeof this.deviceManager.updateDeviceStatus === "function"
        ) {
          await this.deviceManager.updateDeviceStatus(key, "error");
        }
      } catch (e) {
        this.logger.warn(
          `Failed to update device status for ${key}:`,
          e && e.message
        );
      }
    }
  }

  async closeAllSessions() {
    this.shuttingDown = true;
    const keys = Object.keys(this.sessions);
    // mark sessions as disconnected during application shutdown (not removed)
    await Promise.all(
      keys.map((k) => this.removeSession(k, false, "disconnected"))
    );
  }

  async removeSession(key, deleteFolder = false, status = "removed") {
    const session = this.sessions[key];
    if (!session) return;

    try {
      if (session.socket) {
        try {
          if (
            session.socket.ws &&
            typeof session.socket.ws.close === "function"
          )
            session.socket.ws.close();
          else if (typeof session.socket.close === "function")
            await session.socket.close();
        } catch (e) {}
      }

      delete this.sessions[key];

      if (deleteFolder) {
        const sessionPath = path.join(this.folderSession, key);
        try {
          await fs.promises.rm(sessionPath, { recursive: true, force: true });
        } catch (e) {}
      }

      try {
        if (
          this.deviceManager &&
          typeof this.deviceManager.updateDeviceStatus === "function"
        ) {
          await this.deviceManager.updateDeviceStatus(key, status);
        }
      } catch (e) {
        this.logger.warn(
          `Failed to update device status for ${key}:`,
          e && e.message
        );
      }
    } catch (err) {
      this.logger.error(`removeSession error for ${key}:`, err && err.message);
    }
  }

  /**
   * Records Opt-In status for a number
   * @param {number} uid User ID who owns the device
   * @param {number} deviceId Device ID used for the opt-in
   * @param {string} number Phone number (clean format)
   * @param {string} status 'pending', 'approved', 'blocked'
   * @param {string} source 'chat_explicit', 'chat_implicit', 'form', 'app', 'history'
   */
  async recordOptIn(
    uid,
    deviceId,
    number,
    status = "approved",
    source = "chat_implicit"
  ) {
    try {
      // Ensure we only have the digits
      const cleanNumber = number.replace(/\D/g, "");
      const agreedAt = status === "approved" ? "NOW()" : "NULL";

      const query = `
        INSERT INTO opt_ins (uid, device_id, number, status, source, agreed_at) 
        VALUES (?, ?, ?, ?, ?, ${agreedAt}) 
        ON DUPLICATE KEY UPDATE 
          status = VALUES(status), 
          source = VALUES(source),
          device_id = VALUES(device_id),
          agreed_at = CASE WHEN VALUES(status) = 'approved' THEN NOW() ELSE agreed_at END,
          updated_at = NOW()
      `;

      await this.pool.query(query, [
        uid,
        deviceId,
        cleanNumber,
        status,
        source,
      ]);
      this.logger.info(
        `Opt-In status updated: ${cleanNumber} -> ${status} (${source}) for UID ${uid}`
      );
    } catch (error) {
      this.logger.error(`recordOptIn error for ${number}:`, error.message);
    }
  }

  async upsertContacts(uid, deviceId, contacts) {
    if (!uid || !deviceId || !contacts) return;
    this.logger.info(
      `Upserting ${contacts.length} contacts for device ${deviceId}...`
    );

    for (const contact of contacts) {
      try {
        if (!contact.id) continue;

        let phone = null;
        if (contact.id.endsWith("@s.whatsapp.net")) {
          phone = contact.id.split("@")[0];
        }

        // --- NEW: LID Cross-Linking ---
        // If Baileys provides a 'lid' property for a PN JID, we store the mapping
        if (contact.lid && phone) {
          await this.pool.query(
            "INSERT INTO contacts (uid, device_id, jid, phone, name) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE phone = VALUES(phone), updated_at = NOW()",
            [
              uid,
              deviceId,
              contact.lid,
              phone,
              contact.name || contact.verifiedName || contact.notify || null,
            ]
          );
          this.logger.info(`Cross-linked LID ${contact.lid} to phone ${phone}`);
        }
        // ------------------------------

        const query = `
          INSERT INTO contacts (uid, device_id, jid, phone, name)
          VALUES (?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            phone = COALESCE(VALUES(phone), phone),
            name = COALESCE(VALUES(name), name),
            updated_at = NOW()
        `;

        await this.pool.query(query, [
          uid,
          deviceId,
          contact.id,
          phone,
          contact.name || contact.verifiedName || contact.notify || null,
        ]);
      } catch (err) {
        // Silently skip failed contacts
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
