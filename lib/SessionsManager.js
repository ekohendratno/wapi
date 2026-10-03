const path = require("path");
const fs = require("fs");
const qrcode = require("qrcode");
const pino = require("pino");
const axios = require("axios");

const { generateGroupID } = require("./Generate");

class SessionManager {
  constructor(pool, io, deviceManager, folderSession = "./.sessions") {
    this.pool = pool;
    this.io = io;
    this.deviceManager = deviceManager;
    this.folderSession = folderSession;
    this.aiManager = null;
    this.messageManager = null;
    this.sessions = {};
    this.shuttingDown = false;
    this._baileys = null;
    this.logger = pino({ level: process.env.WA_LOG_LEVEL || "info" });
    // Retry backoff per session key to avoid hot reconnect loops
    this.reconnectAttempts = new Map();

    // Initialize Autoreply Cache
    this.autoreplyCache = [];
    this.refreshAutoreplyCache(); // Start caching in background

    if (!fs.existsSync(this.folderSession)) {
      fs.mkdirSync(this.folderSession, { recursive: true });
    }

    // Cache to prevent double replies (Identity Merging side effect)
    this.messageReplyCache = new Map();
    setInterval(() => {
      const now = Date.now();
      for (const [key, time] of this.messageReplyCache.entries()) {
        if (now - time > 10000) this.messageReplyCache.delete(key);
      }
    }, 30000);

    // Per-session in-memory caches required by Baileys rc10+ (retry counter,
    // media, user devices) plus group metadata cache. Without these Baileys
    // re-queries WA on every send, which is a known ban signal.
    this.caches = {};

    // Recently sent raw messages keyed by msg id, so Baileys `getMessage`
    // can resend instead of failing with "message absent from node".
    this.recentSent = new Map();
    setInterval(() => {
      if (this.recentSent.size > 500) {
        const drop = this.recentSent.size - 400;
        let i = 0;
        for (const k of this.recentSent.keys()) {
          this.recentSent.delete(k);
          if (++i >= drop) break;
        }
      }
    }, 60000);

    // Per-session send pacing (anti-ban). Track last outbound send time so
    // bursts from /v1 API cannot exceed a safe rate.
    this.sendThrottle = new Map();
    this.SEND_MIN_GAP_MS = parseInt(process.env.WA_SEND_MIN_GAP_MS || "2500", 10);
    this.SEND_JITTER_MS = parseInt(process.env.WA_SEND_JITTER_MS || "2000", 10);
  }

  getMapCache(key, name) {
    const bucket = (this.caches[key] = this.caches[key] || {});
    if (!bucket[name]) bucket[name] = new Map();
    return bucket[name];
  }

  getCacheStore(key, name) {
    const map = this.getMapCache(key, name);
    return {
      get: async (k) => map.get(k),
      set: async (k, v) => {
        map.set(k, v);
      },
      del: async (k) => {
        map.delete(k);
      },
      flushAll: async () => {
        map.clear();
      },
      close: () => {
        map.clear();
      },
    };
  }

  /**
   * Anti-ban pacing. Waits so the gap between two outbound messages on the
   * same session is >= SEND_MIN_GAP_MS + random jitter. Must be awaited right
   * before every socket.sendMessage call.
   */
  async throttleSend(key) {
    const now = Date.now();
    const last = this.sendThrottle.get(key) || 0;
    const wait = last + this.SEND_MIN_GAP_MS + Math.floor(Math.random() * this.SEND_JITTER_MS) - now;
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
    this.sendThrottle.set(key, Date.now());
  }

  setAiManager(aiManager) {
    this.aiManager = aiManager;
  }

  setMessageManager(messageManager) {
    this.messageManager = messageManager;
  }

  async refreshAutoreplyCache() {
    try {
      const [rows] = await this.pool.query(
        "SELECT * FROM autoreply WHERE status = 'active'",
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
          arr.slice(i * size, i * size + size),
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
                `initSessions: missing or inaccessible creds.json for session ${k} (path=${sessionPath}). Skipping session creation.`,
              );
              try {
                if (this.deviceManager?.updateDeviceStatus) {
                  await this.deviceManager.updateDeviceStatus(k, "error");
                }
              } catch (e) {
                this.logger.warn(
                  `initSessions: failed to mark device ${k} as error: ${e.message}`,
                );
              }
            }
          }),
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
        impErr && (impErr.message || impErr),
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

      // rc14: cache group metadata per-session to cut redundant WA requests
      const groupMetaCache = this.getMapCache(key, "groupMeta");

      const retryCache = this.getCacheStore(key, "retry");
      const mediaCache = this.getCacheStore(key, "media");
      const deviceCache = this.getCacheStore(key, "devices");

      const socket = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: process.env.WA_LOG_LEVEL || "warn" }),
        browser: Browsers
          ? Browsers.ubuntu("Chrome")
          : ["Ubuntu", "Chrome", "124.0.0"],
        syncFullHistory: process.env.WA_SYNC_FULL_HISTORY === "1",
        shouldSyncHistoryMessage: () =>
          process.env.WA_SYNC_HISTORY_ON_RECONNECT !== "0",
        // rc10+: renamed from `markOnline`. false => never show as online (anti-ban)
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        retryRequestDelayMs: 1000,
        // rc10: cap retries, avoid WA flagging resend storms
        maxMsgRetryCount: 2,
        // rc10: auto re-create session + recent message cache for reliable resend
        enableAutoSessionRecreation: true,
        enableRecentMessageCache: true,
        countryCode: process.env.WA_COUNTRY_CODE || "62",
        emitOwnEvents: false,
        // persistent-ish caches: fewer re-uploads, fewer WA round trips
        msgRetryCounterCache: retryCache,
        mediaCache,
        userDevicesCache: deviceCache,
        // rc10: never request group metadata twice for the same jid in a burst
        cachedGroupMetadata: async (jid) => {
          if (groupMetaCache.has(jid)) {
            return groupMetaCache.get(jid);
          }
          const meta = await socket.groupMetadata(jid);
          groupMetaCache.set(jid, meta);
          if (groupMetaCache.size > 200) {
            const firstKey = groupMetaCache.keys().next().value;
            groupMetaCache.delete(firstKey);
          }
          return meta;
        },
        // ignore status broadcast noise; reduces decrypt/proto churn
        shouldIgnoreJid: (jid) => jid === "status@broadcast",
        appStateMacVerification: { patch: true, snapshot: true },
        // real getMessage so rc10 retry path can resend instead of duplicating
        getMessage: async (msgKey) => {
          try {
            return this.recentSent.get(msgKey.id) || undefined;
          } catch (e) {
            return undefined;
          }
        },
      });

      session.socket = socket;
      socket.ev.on("creds.update", saveCreds);

      // --- REGISTER EVENT LISTENERS ONCE PER SOCKET ---
      socket.ev.on("messaging-history.set", ({ contacts, messages }) => {
        if (contacts)
          this.upsertContacts(session.uid, session.deviceId, contacts);
        if (Array.isArray(messages) && messages.length > 0) {
          this.logger.info(
            `History sync received ${messages.length} messages for ${key}; forwarding to inbox/opt-in pipeline.`,
          );
          setImmediate(() => {
            if (typeof socket.ev.emit === "function") {
              socket.ev.emit("messages.upsert", {
                messages,
                type: "append",
              });
            }
          });
        }
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

        if (type !== "notify" && type !== "append") return;
        if (!messages || messages.length === 0) return;

        for (const msg of messages) {
          if (this.shuttingDown) break;

          const remoteJid = msg.key?.remoteJid || "";

          const m = msg.message;
          const messageContent =
            m?.conversation ||
            m?.extendedTextMessage?.text ||
            m?.imageMessage?.caption ||
            m?.videoMessage?.caption ||
            m?.templateButtonReplyMessage?.selectedId ||
            m?.buttonsResponseMessage?.selectedButtonId ||
            m?.listResponseMessage?.singleSelectReply?.selectedRowId ||
            m?.viewOnceMessage?.message?.conversation ||
            m?.viewOnceMessage?.message?.extendedTextMessage?.text ||
            m?.viewOnceMessageV2?.message?.conversation ||
            m?.viewOnceMessageV2?.message?.extendedTextMessage?.text ||
            m?.ephemeralMessage?.message?.conversation ||
            m?.ephemeralMessage?.message?.extendedTextMessage?.text ||
            m?.ephemeralMessage?.message?.imageMessage?.caption ||
            "";

          const lowerMessage = messageContent.trim().toLowerCase();

          if (msg.key?.fromMe) {
            if (
              lowerMessage !== "/register" &&
              lowerMessage !== "/unregister"
            ) {
              continue;
            }
          }

          const pushName = msg.pushName || null;

          // Update contact name if pushName is available and we don't have it
          if (pushName && !remoteJid.endsWith("@g.us")) {
            this.upsertContacts(session.uid, session.deviceId, [
              { id: remoteJid, name: pushName },
            ]);
          }

          if (
            typeof messageContent !== "string" ||
            messageContent.trim() === ""
          ) {
            // console.log(`[DEBUG] Empty message content for ${remoteJid}`);
            continue;
          }

          // Remove noisy debug logs

          await this.recordInboxMessage(
            session.uid,
            session.deviceId,
            key,
            remoteJid,
            pushName,
            messageContent,
            msg,
          );

          try {
            if (
              (remoteJid.endsWith("@g.us") ||
                remoteJid.endsWith("@newsletter")) &&
              lowerMessage === "/register"
            ) {
              let groupName = "Unknown Group";
              try {
                if (remoteJid.endsWith("@g.us")) {
                  const metadata =
                    await session.socket.groupMetadata(remoteJid);
                  groupName = metadata.subject;
                }
              } catch (metaErr) {
                console.warn(
                  `[DEBUG] groupMetadata failed for ${remoteJid}: ${metaErr.message}`,
                );
              }

              if (groupName === "Unknown Group") {
                try {
                  const groupMetadata =
                    await session.socket.groupFetchAllParticipating();
                  const matched = groupMetadata[remoteJid];
                  groupName = matched?.subject || "Unknown Group";
                } catch (fetchErr) {
                  console.error(
                    `[DEBUG] groupFetchAllParticipating also failed: ${fetchErr.message}`,
                  );
                }
              }

              const [existing] = await this.pool.query(
                "SELECT id FROM `groups` WHERE group_id = ? AND device_key = ?",
                [remoteJid, key],
              );

              if (existing.length === 0) {
                const group_key = generateGroupID();
                await this.pool.query(
                  "INSERT INTO `groups` (group_id, group_key, name, device_key, registered_at) VALUES (?, ?, ?, ?, ?)",
                  [remoteJid, group_key, groupName, key, new Date()],
                );
                this.logger.info(
                  `Group registered: ${group_key} (${groupName})`,
                );
                await session.socket.sendMessage(remoteJid, {
                  text: `Grup/Channel berhasil terdaftar: *${group_key}*`,
                });
              } else {
                this.logger.info(`Group already registered: ${remoteJid}`);
                await session.socket.sendMessage(remoteJid, {
                  text: `Grup/Channel sudah terdaftar`,
                });
              }
              continue;
            }

            // --- WEBHOOK LOGIC ---
            try {
              if (session.uid && session.deviceId) {
                // Fetch webhook_url for this device (cached or db)
                // Ideally, cache this similarly to autoreply to avoid DB hit every message
                const [deviceRow] = await this.pool.query(
                  "SELECT webhook_url FROM devices WHERE id = ? LIMIT 1",
                  [session.deviceId],
                );

                if (deviceRow.length > 0 && deviceRow[0].webhook_url) {
                  const webhookUrl = deviceRow[0].webhook_url;
                  // Construct payload
                  const payload = {
                    event: "messages.upsert",
                    device_key: key,
                    remoteJid: remoteJid,
                    pushName: pushName,
                    message: messageContent,
                    timestamp: msg.messageTimestamp,
                    fromMe: msg.key.fromMe || false,
                    isGroup: remoteJid.endsWith("@g.us"),
                  };

                  // Send webhook async (fire and forget)
                  axios
                    .post(webhookUrl, payload, { timeout: 10000 })
                    .then((resp) =>
                      this.recordWebhookLog(
                        session.uid,
                        session.deviceId,
                        key,
                        webhookUrl,
                        payload.event,
                        "success",
                        resp.status,
                        null,
                        payload,
                      ),
                    )
                    .catch((err) => {
                      this.logger.error(
                        `Webhook send failed to ${webhookUrl}: ${err.message}`,
                      );
                      this.recordWebhookLog(
                        session.uid,
                        session.deviceId,
                        key,
                        webhookUrl,
                        payload.event,
                        "failed",
                        err.response?.status || null,
                        err.message,
                        payload,
                      ).catch(() => {});
                    });
                }
              }
            } catch (whErr) {
              this.logger.error(`Webhook logic error: ${whErr.message}`);
            }
            // ---------------------

            let inboundCleanNumber = remoteJid
              .replace(/:[0-9]+/, "")
              .split("@")[0]
              .replace(/\D/g, "");

            // --- OPT-IN LOGIC ---
            if (
              !remoteJid.endsWith("@g.us") &&
              session.uid &&
              session.deviceId
            ) {
              const optInFeatureEnabled =
                String(process.env.FEATURE_OPT_IN) === "1";
              const cleanJid = remoteJid.replace(/:[0-9]+/, "");
              let cleanNumber = cleanJid.split("@")[0].replace(/\D/g, "");

              // --- DEDUPLICATION: Prevent double replies for LID/PN identities ---
              // We use two keys: one for the number (if resolved) and one for the raw JID
              const msgUniqueKey = `${session.uid}:${cleanNumber}:${lowerMessage}`;
              const jidUniqueKey = `${session.uid}:${cleanJid}:${lowerMessage}`;
              const now = Date.now();

              if (
                (this.messageReplyCache.has(msgUniqueKey) &&
                  now - this.messageReplyCache.get(msgUniqueKey) < 10000) ||
                (this.messageReplyCache.has(jidUniqueKey) &&
                  now - this.messageReplyCache.get(jidUniqueKey) < 10000)
              ) {
                this.logger.info(
                  `Skipping duplicate message processing for ${remoteJid}/${cleanNumber} (${lowerMessage})`,
                );
                return;
              }
              // ------------------------------------------------------------------

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
                  [session.uid, session.deviceId, `%${stanzaId}%`],
                );
                if (origMsg.length > 0) {
                  // Use the number we originally sent to
                  const resolvedNumber =
                    origMsg[0].number.split(",")[1] ||
                    origMsg[0].number.split(",")[0]; // Handle comma separated list
                  const cleanResolved = resolvedNumber.replace(/\D/g, "");
                  if (cleanResolved) {
                    cleanNumber = cleanResolved;
                    this.logger.info(
                      `Resolved JID ${remoteJid} to phone number ${cleanNumber} via stanzaId ${stanzaId}`,
                    );
                  }
                }
              }

              const rawPhoneNumber = this.extractPhoneFromRawMessage(msg);
              if (rawPhoneNumber && rawPhoneNumber !== cleanNumber) {
                cleanNumber = rawPhoneNumber;
                this.logger.info(
                  `Resolved ${remoteJid} to phone number ${cleanNumber} from raw message payload`,
                );
              }

              // --- NEW: LID Resolution via Contacts Table ---
              if (remoteJid.includes("@lid")) {
                const [contactRows] = await this.pool.query(
                  "SELECT phone, name FROM contacts WHERE uid = ? AND jid = ? LIMIT 1",
                  [session.uid, cleanJid],
                );

                if (contactRows.length > 0) {
                  if (contactRows[0].phone) {
                    cleanNumber = contactRows[0].phone.replace(/\D/g, "");
                    this.logger.info(
                      `Resolved LID ${remoteJid} to phone number ${cleanNumber} via contact mapping`,
                    );
                  } else if (
                    contactRows[0].name &&
                    contactRows[0].name !== "Tanpa Nama"
                  ) {
                    // Try match by exact Name across all contacts of this user
                    const [namedPN] = await this.pool.query(
                      "SELECT phone FROM contacts WHERE uid = ? AND name = ? AND phone IS NOT NULL LIMIT 1",
                      [session.uid, contactRows[0].name],
                    );
                    if (namedPN.length > 0) {
                      cleanNumber = namedPN[0].phone.replace(/\D/g, "");
                      this.logger.info(
                        `Resolved LID ${remoteJid} to phone number ${cleanNumber} via name matching (${contactRows[0].name})`,
                      );

                      // Update the LID contact record with the phone we found for future use
                      await this.pool.query(
                        "UPDATE contacts SET phone = ? WHERE jid = ? AND uid = ?",
                        [cleanNumber, remoteJid, session.uid],
                      );
                    }
                  }
                }
              }
              // ----------------------------------------------

              const optInKeywords = [
                "setuju",
                "srtuju",
                "stuju",
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
              const sharedTargetUids = await this.findSharedInboundTargetUids(
                session.uid,
                session.deviceId,
                cleanNumber,
              );

              for (const targetUid of sharedTargetUids) {
                await this.recordInboxMessage(
                  targetUid,
                  session.deviceId,
                  key,
                  remoteJid,
                  pushName,
                  messageContent,
                  msg,
                );
              }

              if (
                optOutKeywords.some(
                  (k) => lowerMessage === k || lowerMessage.includes(k),
                )
              ) {
                await this.recordOptIn(
                  session.uid,
                  session.deviceId,
                  cleanNumber,
                  "blocked",
                  "chat_explicit",
                );
                for (const targetUid of sharedTargetUids) {
                  await this.recordOptIn(
                    targetUid,
                    session.deviceId,
                    cleanNumber,
                    "blocked",
                    "chat_explicit",
                  );
                }

                // Mark both keys as replied BEFORE sending to prevent race conditions
                this.messageReplyCache.set(msgUniqueKey, Date.now());
                this.messageReplyCache.set(jidUniqueKey, Date.now());

                await session.socket.sendMessage(remoteJid, {
                  text: "Anda telah berhenti berlangganan notifikasi. Kirim 'SETUJU' kapan saja untuk mengaktifkan kembali.",
                });
                continue;
              } else if (
                optInKeywords.some(
                  (k) => lowerMessage === k || lowerMessage.includes(k),
                )
              ) {
                // Mark both keys as replied BEFORE sending to prevent race conditions
                this.messageReplyCache.set(msgUniqueKey, Date.now());
                this.messageReplyCache.set(jidUniqueKey, Date.now());

                this.logger.info(
                  `Keywords matched! Recording opt-in for ${cleanNumber}`,
                );

                await this.recordOptIn(
                  session.uid,
                  session.deviceId,
                  cleanNumber,
                  "approved",
                  "chat_explicit",
                );
                for (const targetUid of sharedTargetUids) {
                  await this.recordOptIn(
                    targetUid,
                    session.deviceId,
                    cleanNumber,
                    "approved",
                    "chat_explicit",
                  );
                }

                this.logger.info(
                  `[OptIn-Trace] Sending LONG confirmation to ${remoteJid}`,
                );
                await session.socket.sendMessage(remoteJid, {
                  text: "Terima kasih! Nomor Anda telah terdaftar untuk menerima notifikasi otomatis dari kami. Balas 'STOP' untuk berhenti berlangganan.",
                });
                continue;
              } else {
                if (optInFeatureEnabled) {
                  await this.recordOptIn(
                    session.uid,
                    session.deviceId,
                    cleanNumber,
                    "approved",
                    "chat_implicit",
                  );
                  for (const targetUid of sharedTargetUids) {
                    await this.recordOptIn(
                      targetUid,
                      session.deviceId,
                      cleanNumber,
                      "approved",
                      "chat_implicit",
                    );
                  }
                }
              }
              inboundCleanNumber = cleanNumber;
            }
            // --- END OPT-IN LOGIC ---

            if (
              (remoteJid.endsWith("@g.us") ||
                remoteJid.endsWith("@newsletter")) &&
              lowerMessage === "/unregister"
            ) {
              const [existing] = await this.pool.query(
                "SELECT id FROM `groups` WHERE group_id = ? AND device_key = ?",
                [remoteJid, key],
              );
              if (existing.length > 0) {
                await this.pool.query(
                  "DELETE FROM `groups` WHERE group_id = ? AND device_key = ?",
                  [remoteJid, key],
                );
                this.logger.info(`Group unregistered: ${remoteJid}`);
                await session.socket.sendMessage(remoteJid, {
                  text: `Grup/Channel telah berhasil *diunregister*.`,
                });
              } else {
                this.logger.info(
                  `Group not found during unregister: ${remoteJid}`,
                );
                await session.socket.sendMessage(remoteJid, {
                  text: `Grup/Channel ini belum terdaftar.`,
                });
              }
              continue;
            }

            // --- AUTOREPLY LOGIC ---
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
                      : false), // Strict check on deviceId
                );
                if (matched) {
                  rows = [matched];
                }
              }
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
                await session.socket.sendPresenceUpdate("composing", remoteJid);

                // 3. Random delay between 2 to 5 seconds
                const delayMs = Math.floor(Math.random() * 3000) + 2000;
                await new Promise((resolve) => setTimeout(resolve, delayMs));

                this.logger.info(
                  `[AutoReply-Trace] Sending response to ${remoteJid}: ${rows[0].response.substring(0, 20)}...`,
                );
                await session.socket.sendMessage(remoteJid, {
                  text: rows[0].response,
                });

                // 5. Stop typing
                await session.socket.sendPresenceUpdate("paused", remoteJid);
              } catch (sendErr) {
                this.logger.error(
                  "Error sending autoreply with simulation:",
                  sendErr,
                );
                // Fallback to direct send if simulation fails
                await session.socket.sendMessage(remoteJid, {
                  text: rows[0].response,
                });
              }
            } else if (this.aiManager && messageContent) {
              try {
                const sharedAiTarget = await this.findSharedInboundAiTarget(
                  session.uid,
                  session.deviceId,
                  inboundCleanNumber,
                );
                const shareAiMode = sharedAiTarget?.mode || "";
                const shareAiAllowed = shareAiMode === "draft" || shareAiMode === "auto";
                const aiUid = shareAiAllowed ? sharedAiTarget.uid : session.uid;
                const aiResult = await this.aiManager.handleIncomingMessage({
                  uid: aiUid,
                  deviceId: session.deviceId,
                  remoteJid,
                  messageText: messageContent,
                  isGroup:
                    remoteJid.endsWith("@g.us") ||
                    remoteJid.endsWith("@newsletter"),
                  overrideDraftOnly: shareAiAllowed
                    ? shareAiMode === "draft"
                    : null,
                });

                if (aiResult.handled && !aiResult.draftOnly && aiResult.text) {
                  if (typeof session.socket.readMessages === "function") {
                    await session.socket.readMessages([msg.key]);
                  }
                  await session.socket.sendPresenceUpdate("composing", remoteJid);
                  const delayMs = Math.floor(Math.random() * 2500) + 1500;
                  await new Promise((resolve) => setTimeout(resolve, delayMs));
                  await session.socket.sendMessage(remoteJid, {
                    text: aiResult.text,
                  });
                  await session.socket.sendPresenceUpdate("paused", remoteJid);
                }
              } catch (aiErr) {
                this.logger.error("AI autoreply error:", aiErr && aiErr.message);
                try {
                  await this.aiManager.log(session.uid, {
                    prompt: `remote:${remoteJid}\nmessage:${messageContent}`,
                    response: null,
                    status: "error",
                    error_message: aiErr.message || "AI autoreply runtime error",
                    source: "whatsapp",
                  });
                } catch (logErr) {
                  this.logger.error("AI autoreply log error:", logErr && logErr.message);
                }
              }
            }
          } catch (err) {
            this.logger.error("message handler error:", err && err.message);
          }
        }
      });

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
                pushName,
              );
            }
          } catch (e) {
            this.logger.warn(
              `Failed to persist connected status for ${key}:`,
              e && e.message,
            );
          }

          // Cache device_id for this session to scope autoreply lookups
          try {
            const [drows] = await this.pool.query(
              "SELECT id, uid FROM devices WHERE device_key = ? LIMIT 1",
              [key],
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
              e && e.message,
            );
          }

          try {
            if (session.uid && this.messageManager?.syncOptInsFromInbox) {
              const result = await this.messageManager.syncOptInsFromInbox(
                session.uid,
              );
              this.logger.info(
                `Opt-in inbox resync after reconnect for ${key}: approved=${result.approved || 0}, blocked=${result.blocked || 0}`,
              );
            }
          } catch (e) {
            this.logger.warn(
              `Opt-in inbox resync failed for ${key}: ${e && e.message}`,
            );
          }
        }

        if (connection === "close") {
          session.connected = false;
          this.io.emit("connection-status", { key, connected: false });

          if (lastDisconnect?.error) {
            const statusCode =
              lastDisconnect.error.output?.statusCode ||
              lastDisconnect.error.data?.statusCode ||
              null;
            const errMessage = lastDisconnect.error.message || "";

            this.logger.warn(
              `Connection closed ${key}: code=${statusCode} msg="${errMessage}"`,
            );

            // --- BAILEYS rc10+ CLASSIFICATION (anti-ban) ---
            // Do NOT reconnect blindly: 401/403/419/440 are permanent states.
            // Only transient errors (408/428/515) warrant reconnection.

            const isBanned = statusCode === 403 || errMessage.includes("403");
            const isRateLimited =
              statusCode === 429 || errMessage.includes("429");
            const isTimelocked =
              errMessage.includes("463") ||
              errMessage.includes("restricted") ||
              errMessage.includes("ACCOUNT_RESTRICTED");
            const isLoggedOut =
              statusCode === DisconnectReason.loggedOut ||
              statusCode === 401;
            const isReplaced =
              statusCode === DisconnectReason.connectionReplaced ||
              statusCode === 440;
            const isSessionExpired =
              statusCode === 419 || errMessage.includes("419");
            const isRestartRequired =
              statusCode === DisconnectReason.restartRequired ||
              statusCode === 515;
            const isConnectionClosed =
              statusCode === DisconnectReason.connectionClosed ||
              statusCode === 428;
            const isConnectionLost =
              statusCode === DisconnectReason.connectionLost ||
              statusCode === 408 ||
              statusCode === DisconnectReason.timedOut;
            const isBadSession =
              statusCode === DisconnectReason.badSession || statusCode === 500;

            // Helper: close socket without error
            const cleanupSocket = async () => {
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
            };

            // Helper: update device status in DB
            const markDeviceStatus = async (status) => {
              try {
                if (
                  this.deviceManager &&
                  typeof this.deviceManager.updateDeviceStatus === "function"
                ) {
                  await this.deviceManager.updateDeviceStatus(key, status);
                }
              } catch (e) {
                this.logger.warn(
                  `Failed to update device status (${status}) for ${key}:`,
                  e && e.message,
                );
              }
            };

            // Helper: reconnect with exponential backoff
            const scheduleReconnect = async (baseMs, maxMs) => {
              if (session.reconnecting) return;
              session.reconnecting = true;
              const attempts = (this.reconnectAttempts.get(key) || 0) + 1;
              this.reconnectAttempts.set(key, attempts);
              const backoffMs = Math.min(baseMs * attempts, maxMs);
              this.logger.info(
                `Scheduling reconnect ${key} in ${backoffMs}ms (attempt #${attempts})`,
              );
              setTimeout(() => {
                this.createSession(key).finally(() => {
                  session.reconnecting = false;
                  if (session.connected) this.reconnectAttempts.delete(key);
                });
              }, backoffMs);
            };

            // --- 401 loggedOut: credentials gone, do NOT reconnect ---
            if (isLoggedOut) {
              session.error = true;
              session.lastError =
                "Device logged out by WhatsApp (loggedOut). Re-scan QR required.";
              this.logger.warn(`Device ${key} logged out. Session marked as error.`);
              await markDeviceStatus("disconnected");
              await cleanupSocket();
            }
            // --- 403 banned: account or device blocked, do NOT reconnect ---
            else if (isBanned) {
              session.error = true;
              session.lastError =
                "Account/device blocked by WhatsApp (403). Do NOT reconnect automatically — wait for WhatsApp to lift the restriction or contact WhatsApp Support.";
              this.logger.error(
                `Device ${key} BLOCKED (403). Stopping reconnect. Manual intervention required.`,
              );
              await markDeviceStatus("blocked");
              await cleanupSocket();
              this.reconnectAttempts.delete(key);
            }
            // --- 463 timelocked (reachout restricted): do NOT reconnect ---
            else if (isTimelocked) {
              session.error = true;
              session.lastError =
                "Account restricted — reachout timelock (463). Send limit exceeded or spam detected. Wait 24h+ before retrying.";
              this.logger.error(
                `Device ${key} RATE-LIMITED/TIMELOCKED (463). No reconnect for 24h.`,
              );
              await markDeviceStatus("restricted");
              await cleanupSocket();
              this.reconnectAttempts.delete(key);
              // schedule a very slow probe after 24h just to detect if restriction is lifted
              setTimeout(
                () => {
                  if (
                    !session.connected &&
                    !session.reconnecting &&
                    session.lastError?.includes("463")
                  ) {
                    this.logger.info(
                      `Timelock probe reconnect ${key} after 24h`,
                    );
                    this.createSession(key).catch(() => {});
                  }
                },
                24 * 60 * 60 * 1000,
              );
            }
            // --- 429 rate-limited: back off hard, then retry ---
            else if (isRateLimited) {
              session.lastError = "Rate limited by WhatsApp (429). Backing off.";
              this.logger.warn(`Device ${key} rate limited (429). Backing off.`);
              await cleanupSocket();
              await scheduleReconnect(30000, 300000);
            }
            // --- 419 session expired: credentials stale ---
            else if (isSessionExpired) {
              session.error = true;
              session.lastError =
                "Session expired (419). Re-scan QR required.";
              this.logger.warn(
                `Device ${key} session expired (419). Marked for re-scan.`,
              );
              await markDeviceStatus("disconnected");
              await cleanupSocket();
              this.reconnectAttempts.delete(key);
            }
            // --- 440 connection replaced: another instance is active ---
            else if (isReplaced) {
              session.error = true;
              session.lastError =
                "Connection replaced by another device (440). Another instance may be active.";
              this.logger.warn(
                `Device ${key} connection replaced (440). No auto-reconnect.`,
              );
              await markDeviceStatus("disconnected");
              await cleanupSocket();
              this.reconnectAttempts.delete(key);
            }
            // --- 515 restart required: WA server asked for reconnect, do it fast ---
            else if (isRestartRequired) {
              this.logger.info(`Device ${key} needs restart (515). Reconnecting...`);
              await cleanupSocket();
              setTimeout(() => {
                this.createSession(key).catch(() => {});
              }, 1500);
            }
            // --- 500 bad session: cleanup auth, then try once ---
            else if (isBadSession) {
              session.lastError = "Bad session (500). Cleaning up and retrying once.";
              this.logger.warn(`Device ${key} bad session (500). Cleaning + retry.`);
              await cleanupSocket();
              // remove corrupted creds.json
              try {
                const credsPath = path.join(
                  this.folderSession,
                  key,
                  "creds.json",
                );
                if (fs.existsSync(credsPath)) {
                  fs.unlinkSync(credsPath);
                }
              } catch (e) {}
              this.reconnectAttempts.delete(key);
              setTimeout(() => {
                this.createSession(key).catch(() => {});
              }, 3000);
            }
            // --- 408/428 transient: reconnect with backoff ---
            else if (isConnectionLost || isConnectionClosed) {
              this.logger.info(
                `Device ${key} transient close (${statusCode}). Reconnecting with backoff.`,
              );
              await cleanupSocket();
              await scheduleReconnect(5000, 60000);
            }
            // --- unknown: safe backoff reconnect ---
            else {
              this.logger.warn(
                `Device ${key} unknown disconnect code ${statusCode}. Reconnecting cautiously.`,
              );
              await cleanupSocket();
              await scheduleReconnect(10000, 120000);
            }
          }
        }
      });

      socket.ev.on("ws.connection", (update) => {
        if (update.error)
          this.logger.error(
            `WS Error (${key}):`,
            update.error && update.error.message,
          );
      });
    } catch (error) {
      this.logger.error(
        `Session Error (${key}):`,
        error && (error.stack || error),
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
          e && e.message,
        );
      }
    }
  }

  async closeAllSessions() {
    this.shuttingDown = true;
    const keys = Object.keys(this.sessions);
    // mark sessions as disconnected during application shutdown (not removed)
    await Promise.all(
      keys.map((k) => this.removeSession(k, false, "disconnected")),
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
          e && e.message,
        );
      }
    } catch (err) {
      this.logger.error(`removeSession error for ${key}:`, err && err.message);
    }
  }

  extractPhoneFromRawMessage(rawMessage) {
    const seen = new Set();
    const stack = [rawMessage];

    while (stack.length) {
      const value = stack.pop();
      if (!value) continue;

      if (typeof value === "string") {
        const jidMatch = value.match(/(?:62|0)\d{8,15}@s\.whatsapp\.net/i);
        if (jidMatch) {
          return this.normalizeIndonesianPhone(jidMatch[0].split("@")[0]);
        }

        const phoneMatch = value.match(/(?:\+?62|0)\d{8,15}/);
        if (phoneMatch) {
          return this.normalizeIndonesianPhone(phoneMatch[0]);
        }
        continue;
      }

      if (typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);

      for (const key of Object.keys(value)) {
        if (key === "text" || key === "conversation") continue;
        stack.push(value[key]);
      }
    }

    return null;
  }

  normalizeIndonesianPhone(phone) {
    let cleanPhone = String(phone || "").replace(/\D/g, "");
    if (cleanPhone.startsWith("08")) {
      cleanPhone = "628" + cleanPhone.slice(2);
    } else if (cleanPhone.startsWith("0")) {
      cleanPhone = "62" + cleanPhone.slice(1);
    }
    return cleanPhone.startsWith("62") ? cleanPhone : null;
  }

  async findSharedInboundTargetUids(ownerUid, deviceId, cleanNumber) {
    const phone = this.normalizeIndonesianPhone(cleanNumber) || cleanNumber;
    if (!ownerUid || !deviceId || !phone) return [];

    try {
      const [rows] = await this.pool.query(
        `
          SELECT ds.shared_uid, MAX(m.created_at) AS latest_message_at
          FROM device_shares ds
          JOIN messages m
            ON m.uid = ds.shared_uid
           AND m.device_id = ds.device_id
          WHERE ds.owner_uid = ?
            AND ds.device_id = ?
            AND ds.status = 'active'
            AND ds.permission_send = 1
            AND ds.shared_uid IS NOT NULL
            AND (ds.expires_at IS NULL OR ds.expires_at > NOW())
            AND m.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
            AND (
              FIND_IN_SET(?, REPLACE(REPLACE(REPLACE(m.number, ' ', ''), '+', ''), '-', '')) > 0
              OR REPLACE(REPLACE(REPLACE(m.number, ' ', ''), '+', ''), '-', '') = ?
              OR m.number LIKE ?
            )
          GROUP BY ds.shared_uid
          ORDER BY latest_message_at DESC
          LIMIT 5
        `,
        [ownerUid, deviceId, phone, phone, `%${phone}%`],
      );

      return rows
        .map((row) => Number(row.shared_uid))
        .filter(
          (uid) =>
            Number.isInteger(uid) && uid > 0 && uid !== Number(ownerUid),
        );
    } catch (error) {
      this.logger.warn(
        `findSharedInboundTargetUids failed for ${phone}: ${error.message}`,
      );
      return [];
    }
  }

  async findSharedInboundAiTarget(ownerUid, deviceId, cleanNumber) {
    const phone = this.normalizeIndonesianPhone(cleanNumber) || cleanNumber;
    if (!ownerUid || !deviceId || !phone) return null;

    try {
      const [rows] = await this.pool.query(
        `
          SELECT ds.shared_uid, ds.ai_reply_mode, MAX(m.created_at) AS latest_message_at
          FROM device_shares ds
          JOIN messages m
            ON m.uid = ds.shared_uid
           AND m.device_id = ds.device_id
          WHERE ds.owner_uid = ?
            AND ds.device_id = ?
            AND ds.status = 'active'
            AND ds.permission_send = 1
            AND ds.shared_uid IS NOT NULL
            AND (ds.expires_at IS NULL OR ds.expires_at > NOW())
            AND m.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
            AND (
              FIND_IN_SET(?, REPLACE(REPLACE(REPLACE(m.number, ' ', ''), '+', ''), '-', '')) > 0
              OR REPLACE(REPLACE(REPLACE(m.number, ' ', ''), '+', ''), '-', '') = ?
              OR m.number LIKE ?
            )
          GROUP BY ds.shared_uid, ds.ai_reply_mode
          ORDER BY latest_message_at DESC
          LIMIT 1
        `,
        [ownerUid, deviceId, phone, phone, `%${phone}%`],
      );

      if (!rows.length) return null;
      const uid = Number(rows[0].shared_uid);
      if (!Number.isInteger(uid) || uid <= 0 || uid === Number(ownerUid)) {
        return null;
      }
      return {
        uid,
        mode: rows[0].ai_reply_mode || "off",
      };
    } catch (error) {
      this.logger.warn(
        `findSharedInboundAiTarget failed for ${phone}: ${error.message}`,
      );
      return null;
    }
  }

  async recordInboxMessage(
    uid,
    deviceId,
    deviceKey,
    remoteJid,
    pushName,
    message,
    rawMessage,
  ) {
    if (!uid || !deviceId || !remoteJid || !message) return;

    try {
      await this.pool.query(
        `
          INSERT INTO inbox_messages
            (uid, device_id, device_key, remote_jid, push_name, message, message_id, is_group, from_me, received_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        `,
        [
          uid,
          deviceId,
          deviceKey,
          remoteJid,
          pushName || null,
          message,
          rawMessage?.key?.id || null,
          remoteJid.endsWith("@g.us") ? 1 : 0,
          rawMessage?.key?.fromMe ? 1 : 0,
        ],
      );
    } catch (error) {
      this.logger.warn(`recordInboxMessage failed: ${error.message}`);
    }
  }

  async recordWebhookLog(
    uid,
    deviceId,
    deviceKey,
    webhookUrl,
    event,
    status,
    httpStatus,
    errorMessage,
    payload,
  ) {
    if (!uid || !deviceId || !webhookUrl) return;

    await this.pool.query(
      `
        INSERT INTO webhook_logs
          (uid, device_id, device_key, webhook_url, event, status, http_status, error_message, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        uid,
        deviceId,
        deviceKey,
        webhookUrl,
        event,
        status,
        httpStatus,
        errorMessage,
        JSON.stringify(payload || {}),
      ],
    );
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
    source = "chat_implicit",
  ) {
    try {
      // Ensure we only have the digits and strip device index if present
      const cleanJid = number.replace(/:[0-9]+/, "");
      let cleanNumber = cleanJid.split("@")[0].replace(/\D/g, "");

      const agreedAt = status === "approved" ? "NOW()" : "NULL";

      // --- NEW: Identity Merging (LID <-> Phone) ---
      // 1. Cek apakah nomor ini adalah LID atau Phone yang punya link
      const [contactLink] = await this.pool.query(
        "SELECT jid, phone, name FROM contacts WHERE uid = ? AND (jid LIKE ? OR phone = ?) LIMIT 1",
        [uid, `%${cleanNumber}%`, cleanNumber],
      );

      this.logger.debug(
        `recordOptIn: cleanNumber=${cleanNumber} hasLink=${contactLink.length > 0}`,
      );

      let primaryNumber = cleanNumber;
      let isLid = !cleanNumber.startsWith("62") && cleanNumber.length > 13; // Simple heuristic for LID

      if (contactLink.length > 0) {
        const c = contactLink[0];
        let resolvedPhone = c.phone ? c.phone.replace(/\D/g, "") : null;

        // --- NEW: Fallback resolution by Name if phone is NULL ---
        if (!resolvedPhone && isLid) {
          const [nameRow] = await this.pool.query(
            "SELECT name FROM contacts WHERE uid = ? AND jid LIKE ? AND name IS NOT NULL AND name != 'Tanpa Nama' LIMIT 1",
            [uid, `%${cleanNumber}%`],
          );
          if (nameRow.length > 0) {
            const lidName = nameRow[0].name;
            const [phoneRow] = await this.pool.query(
              "SELECT phone FROM contacts WHERE uid = ? AND name = ? AND phone IS NOT NULL LIMIT 1",
              [uid, lidName],
            );
            if (phoneRow.length > 0) {
              resolvedPhone = phoneRow[0].phone.replace(/\D/g, "");
              this.logger.info(
                `recordOptIn: Found phone ${resolvedPhone} for LID ${cleanNumber} via name ${lidName}`,
              );
            }
          }
        }
        // ---------------------------------------------------------

        if (resolvedPhone) {
          primaryNumber = resolvedPhone;
          // Jika ini LID, kita akan hapus record LID-nya nanti dan pindah ke Phone
          if (cleanNumber !== resolvedPhone) {
            this.logger.info(
              `recordOptIn: Mapping ${cleanNumber} (LID?) to ${resolvedPhone} (Phone)`,
            );
          }
        }
      }

      const isFinalPhone =
        primaryNumber.startsWith("62") || primaryNumber.startsWith("0");
      const isFinalLid = !isFinalPhone && cleanJid.includes("@lid");

      if (!isFinalPhone && !isFinalLid) {
        this.logger.info(
          `recordOptIn: Skipping unsupported final identity ${primaryNumber} (Target JID was ${cleanNumber})`,
        );
        return;
      }

      if (isFinalLid) {
        this.logger.info(
          `recordOptIn: Phone mapping not found, saving LID ${primaryNumber} as opt-in identity`,
        );
      }

      // 2. Insert/Update primary record (diutamakan Phone)
      const query = `
        INSERT INTO opt_ins (uid, device_id, number, status, source, agreed_at, system_blocked_at, block_reason) 
        VALUES (?, ?, ?, ?, ?, ${agreedAt}, NULL, NULL)
        ON DUPLICATE KEY UPDATE 
          status = VALUES(status), 
          source = VALUES(source),
          device_id = VALUES(device_id),
          agreed_at = CASE WHEN VALUES(status) = 'approved' THEN NOW() ELSE agreed_at END,
          system_blocked_at = NULL,
          block_reason = NULL,
          updated_at = NOW()
      `;

      await this.pool.query(query, [
        uid,
        deviceId,
        primaryNumber,
        status,
        source,
      ]);

      await this.pool.query(
        `UPDATE opt_ins
         SET status = ?,
             source = ?,
             agreed_at = CASE WHEN ? = 'approved' THEN NOW() ELSE agreed_at END,
             system_blocked_at = NULL,
             block_reason = NULL,
             updated_at = NOW()
         WHERE device_id = ?
           AND number = ?
           AND uid != ?
           AND status = 'pending'`,
        [status, source, status, deviceId, primaryNumber, uid],
      );

      // 3. Jika tadi kita memetakan dari LID ke Phone, hapus record LID yang lama (jika ada)
      if (primaryNumber !== cleanNumber) {
        await this.pool.query(
          "DELETE FROM opt_ins WHERE uid = ? AND number = ?",
          [uid, cleanNumber],
        );
      }

      this.logger.info(
        `Opt-In status updated: ${primaryNumber} -> ${status} (${source}) for UID ${uid}`,
      );
    } catch (error) {
      this.logger.error(`recordOptIn error for ${number}:`, error.message);
    }
  }

  /**
   * Syncs Opt-In status when an LID <-> Phone mapping is discovered
   */
  async syncOptInAfterMapping(uid, deviceId, lidJid, phone) {
    try {
      const lid = lidJid
        .replace(/:[0-9]+/, "")
        .split("@")[0]
        .replace(/\D/g, "");
      const cleanPhone = phone
        .replace(/:[0-9]+/, "")
        .split("@")[0]
        .replace(/\D/g, "");

      // 1. Ambil data opt-in untuk LID dan nomor HP
      const [records] = await this.pool.query(
        "SELECT number, status, source FROM opt_ins WHERE uid = ? AND number IN (?, ?)",
        [uid, lid, cleanPhone],
      );

      const lidRec = records.find((r) => r.number === lid);
      const phoneRec = records.find((r) => r.number === cleanPhone);

      // 2. Jika LID sudah APPROVED, maka Phone harus APPROVED
      if (lidRec && lidRec.status === "approved") {
        if (!phoneRec || phoneRec.status !== "approved") {
          this.logger.info(
            `Merging APPROVED status from LID ${lid} to Phone ${cleanPhone}`,
          );
          await this.recordOptIn(
            uid,
            deviceId,
            cleanPhone,
            "approved",
            lidRec.source,
          );
        }
        // Hapus record LID karena sudah dipindahkan ke Phone
        await this.pool.query(
          "DELETE FROM opt_ins WHERE uid = ? AND number = ?",
          [uid, lid],
        );
      }
      // 3. Jika LID punya status lain dan Phone belum punya status, pindahkan
      else if (lidRec && !phoneRec) {
        this.logger.info(
          `Moving ${lidRec.status} status from LID ${lid} to Phone ${cleanPhone}`,
        );
        await this.recordOptIn(
          uid,
          deviceId,
          cleanPhone,
          lidRec.status,
          lidRec.source,
        );
        await this.pool.query(
          "DELETE FROM opt_ins WHERE uid = ? AND number = ?",
          [uid, lid],
        );
      }
    } catch (e) {
      this.logger.error(`syncOptInAfterMapping error: ${e.message}`);
    }
  }

  async upsertContacts(uid, deviceId, contacts) {
    if (!uid || !deviceId || !contacts) return;
    this.logger.info(
      `Upserting ${contacts.length} contacts for device ${deviceId}...`,
    );

    for (const contact of contacts) {
      try {
        if (!contact.id) continue;

        const normalizedId = contact.id.replace(/:[0-9]+/, "");
        let phone = null;
        if (normalizedId.endsWith("@s.whatsapp.net")) {
          phone = normalizedId.split("@")[0];
        } else if (contact.phone) {
          phone = contact.phone.replace(/\D/g, "");
        } else if (
          contact.verifiedName &&
          contact.verifiedName.match(/^\d+$/)
        ) {
          phone = contact.verifiedName;
        }

        // --- NORMALIZATION: Format 08/628 for Indonesian Numbers ---
        if (phone) {
          phone = phone.replace(/\D/g, "");
          if (phone.startsWith("08")) {
            phone = "628" + phone.slice(2);
          } else if (phone.startsWith("0")) {
            phone = "62" + phone.slice(1);
          }
        }
        // ------------------------------------------------------------

        // --- NEW: LID Cross-Linking ---
        const contactName =
          contact.name || contact.verifiedName || contact.notify || null;

        // Fallback: If LID has no phone, try to match by exact Name (excluding generic ones)
        if (
          contact.id.endsWith("@lid") &&
          !phone &&
          contactName &&
          contactName.length > 3 &&
          contactName !== "Tanpa Nama"
        ) {
          const [match] = await this.pool.query(
            "SELECT phone FROM contacts WHERE uid = ? AND name = ? AND phone IS NOT NULL LIMIT 1",
            [uid, contactName],
          );
          if (match.length > 0) {
            phone = match[0].phone;
            this.logger.info(
              `Linked LID ${contact.id} to phone ${phone} via Global Name matching (${contactName})`,
            );
          }
        }

        // --- NEW: Identity Sync (Name Match) ---
        // 1. Phone -> LID Name
        if (contact.id.endsWith("@s.whatsapp.net") && !contactName && phone) {
          const [nameMatch] = await this.pool.query(
            "SELECT name FROM contacts WHERE uid = ? AND phone = ? AND name IS NOT NULL AND name != 'Tanpa Nama' LIMIT 1",
            [uid, phone],
          );
          if (nameMatch.length > 0) {
            contact.name = nameMatch[0].name;
          }
        }
        // 2. LID -> Phone Name
        if (contact.id.endsWith("@lid") && !contactName) {
          // We'll update the name later if we find a phone match
        }
        // 3. Merging: If Phone has no name, but LID has name, update Phone's name
        if (contact.id.endsWith("@lid") && contactName && phone) {
          await this.pool.query(
            "UPDATE contacts SET name = ? WHERE uid = ? AND phone = ? AND (name IS NULL OR name = 'Tanpa Nama')",
            [contactName, uid, phone],
          );
        }
        // ---------------------------------------------------

        // If Baileys provides a 'lid' property for a PN JID, or a 'phone' for an LID
        if (normalizedId.endsWith("@s.whatsapp.net") && contact.lid) {
          const normalizedLid = contact.lid.replace(/:[0-9]+/, "");
          await this.pool.query(
            "INSERT INTO contacts (uid, device_id, jid, phone, name) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE phone = VALUES(phone), updated_at = NOW()",
            [uid, deviceId, normalizedLid, phone, contactName],
          );
          this.logger.info(
            `Cross-linked LID ${normalizedLid} to phone ${phone}`,
          );
          // --- NEW: Sync Opt-In status ---
          await this.syncOptInAfterMapping(uid, deviceId, normalizedLid, phone);
        } else if (normalizedId.endsWith("@lid") && phone) {
          // Already have phone from above logic
          await this.pool.query(
            "INSERT INTO contacts (uid, device_id, jid, phone, name) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE phone = COALESCE(VALUES(phone), phone), updated_at = NOW()",
            [uid, deviceId, normalizedId, phone, contactName],
          );

          this.logger.info(
            `Resolved LID ${normalizedId} to phone ${phone} via contact property`,
          );
          // --- NEW: Sync Opt-In status ---
          await this.syncOptInAfterMapping(uid, deviceId, normalizedId, phone);
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
          normalizedId,
          phone,
          contact.name || contact.verifiedName || contact.notify || null,
        ]);
      } catch (err) {
        this.logger.error(
          `upsertContacts error for ${contact.id}: ${err.message}`,
        );
      }
    }
  }

  /**
   * Store a just-sent message so Baileys `getMessage` can serve it on retry.
   * Called by MessageManager after every successful send.
   */
  rememberSentMessage(sentMsg) {
    try {
      const id = sentMsg?.key?.id;
      if (!id) return;
      const raw = sentMsg.message;
      if (raw) this.recentSent.set(id, raw);
    } catch (e) {
      /* best-effort */
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
