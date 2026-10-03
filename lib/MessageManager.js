const moment = require("moment-timezone");
const BoomModule = require("@hapi/boom");
const Boom = BoomModule.Boom;
Object.assign(Boom, BoomModule);
const { isValidGroupId, isValidPhoneNumber } = require("../lib/Utils");

class MessageManager {
  constructor(pool, sessionManager) {
    this.pool = pool;
    this.sessionManager = sessionManager;
    this.safeDailyPercent = Math.min(
      100,
      Math.max(1, Number(process.env.WA_SAFE_DAILY_PERCENT || 90)),
    );
  }

  countRecipients(to = "") {
    return String(to)
      .split(",")
      .map((recipient) => recipient.trim())
      .filter(Boolean).length || 1;
  }

  normalizeRecipientPhone(value = "") {
    let phone = String(value || "").split("@")[0].replace(/\D/g, "");
    if (phone.startsWith("08")) phone = `628${phone.slice(2)}`;
    else if (phone.startsWith("0")) phone = `62${phone.slice(1)}`;
    return phone;
  }

  renderRecipientTemplate(text = "", recipient = "") {
    const phone = this.normalizeRecipientPhone(recipient);
    return String(text || "")
      .replace(/\{\{\s*nomor_wa\s*\}\}/gi, phone)
      .replace(/\{\{\s*phone\s*\}\}/gi, phone)
      .replace(/\{\{\s*nomor\s*\}\}/gi, phone);
  }

  async getDeviceUsageToday(connection, deviceId, today) {
    const [rows] = await connection.query(
      `SELECT COALESCE(SUM(
          COALESCE(NULLIF(recipient_count, 0), 1 + LENGTH(COALESCE(number, '')) - LENGTH(REPLACE(COALESCE(number, ''), ',', '')))
        ), 0) AS total
       FROM messages
       WHERE device_id = ?
         AND DATE(created_at) = ?`,
      [deviceId, today],
    );
    return Number(rows[0]?.total || 0);
  }

  async reserveDeviceDailyLimit(connection, deviceId, limitDaily, today, needed = 1) {
    const limit = Number(limitDaily || 0);
    const requested = Math.max(1, Number(needed || 1));
    if (limit <= 0) {
      return { allowed: true, used: 0, limit, remaining: null };
    }
    const safeLimit = Math.max(1, Math.floor((limit * this.safeDailyPercent) / 100));

    await connection.query("SELECT id FROM devices WHERE id = ? FOR UPDATE", [
      deviceId,
    ]);

    const used = await this.getDeviceUsageToday(connection, deviceId, today);
    const remaining = Math.max(0, safeLimit - used);
    return {
      allowed: remaining >= requested,
      used,
      limit,
      safeLimit,
      safePercent: this.safeDailyPercent,
      remaining,
      requested,
    };
  }

  async getMessages(apiKey, status = "", page = 1, limit = 30) {
    const connection = await this.pool.getConnection();
    try {
      const [users] = await connection.query(
        "SELECT uid FROM users WHERE api_key = ? LIMIT 1",
        [apiKey],
      );
      if (users.length === 0) {
        throw new Boom("Invalid API key", { statusCode: 401 });
      }

      const uid = users[0].uid;
      const todayStart = moment()
        .tz("Asia/Jakarta")
        .startOf("day")
        .format("YYYY-MM-DD HH:mm:ss");
      const todayEnd = moment()
        .tz("Asia/Jakarta")
        .endOf("day")
        .format("YYYY-MM-DD HH:mm:ss");

      // Hanya ambil pesan yang berasal dari device yang TIDAK bertatus 'deleted'
      let query = `
        SELECT
          m.*,
          d.device_key,
          COALESCE(oi.status, 'pending') AS opt_in_status,
          oi.source AS opt_in_source,
          oi.agreed_at AS opt_in_agreed_at
        FROM messages m
        JOIN devices d ON d.id = m.device_id AND d.status != 'deleted'
        LEFT JOIN opt_ins oi
          ON oi.uid = m.uid
         AND oi.number = REPLACE(REPLACE(REPLACE(REPLACE(SUBSTRING_INDEX(m.number, '@', 1), '+', ''), '-', ''), ' ', ''), ':', '')
        WHERE m.uid = ? AND m.created_at BETWEEN ? AND ?`;
      const queryParams = [uid, todayStart, todayEnd];

      if (status !== "all") {
        query += " AND m.status = ?";
        queryParams.push(status);
      }

      query += " ORDER BY m.created_at DESC LIMIT ? OFFSET ?";
      queryParams.push(limit, (page - 1) * limit);

      const [messages] = await connection.query(query, queryParams);

      // Hitung total data sesuai filter
      // Hitung total hanya untuk pesan dari device yang belum dihapus (status != 'deleted')
      let countQuery =
        "SELECT COUNT(*) as total FROM messages m JOIN devices d ON d.id=m.device_id AND d.status != 'deleted' WHERE m.uid = ? AND m.created_at BETWEEN ? AND ?";
      const countParams = [uid, todayStart, todayEnd];
      if (status !== "all") {
        countQuery += " AND m.status = ?";
        countParams.push(status);
      }
      const [[{ total }]] = await connection.query(countQuery, countParams);

      // Hitung per status untuk statistik
      const [statusCounts] = await connection.query(
        "SELECT m.status AS status, COUNT(*) AS count FROM messages m JOIN devices d ON d.id=m.device_id AND d.status != 'deleted' WHERE m.uid = ? AND m.created_at BETWEEN ? AND ? GROUP BY m.status",
        [uid, todayStart, todayEnd],
      );

      const counts = {};
      statusCounts.forEach((row) => {
        counts[row.status] = row.count;
      });

      ["sent", "pending", "failed", "processing"].forEach((s) => {
        counts[s] = counts[s] || 0;
      });

      counts.totalCount = Object.values(counts).reduce(
        (total, c) => total + c,
        0,
      );

      return {
        messages,
        counts,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      console.error("Error retrieving messages:", error);
      throw error.isBoom
        ? error
        : new Boom("Database error", { statusCode: 500 });
    } finally {
      connection.release();
    }
  }

  async getMessageInsights(apiKey) {
    const connection = await this.pool.getConnection();
    try {
      const [users] = await connection.query(
        "SELECT uid FROM users WHERE api_key = ? LIMIT 1",
        [apiKey],
      );
      if (users.length === 0) {
        throw new Boom("Invalid API key", { statusCode: 401 });
      }

      const uid = users[0].uid;
      const [weekRows] = await connection.query(
        `SELECT m.status AS status, COUNT(*) AS count
         FROM messages m
         JOIN devices d ON d.id = m.device_id AND d.status != 'deleted'
         WHERE m.uid = ? AND m.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
         GROUP BY m.status`,
        [uid],
      );

      const week = { sent: 0, pending: 0, failed: 0, processing: 0, total: 0 };
      weekRows.forEach((row) => {
        if (Object.prototype.hasOwnProperty.call(week, row.status)) {
          week[row.status] = Number(row.count || 0);
        }
      });
      week.total = week.sent + week.pending + week.failed + week.processing;
      week.successRate = week.total > 0 ? Math.round((week.sent / week.total) * 100) : 0;

      const [hourRows] = await connection.query(
        `SELECT HOUR(m.created_at) AS hour, COUNT(*) AS total
         FROM messages m
         JOIN devices d ON d.id = m.device_id AND d.status != 'deleted'
         WHERE m.uid = ? AND m.created_at >= CURDATE()
         GROUP BY HOUR(m.created_at)
         ORDER BY hour ASC`,
        [uid],
      );

      const hourly = Array.from({ length: 24 }, (_, hour) => ({
        hour: `${String(hour).padStart(2, "0")}:00`,
        total: 0,
      }));
      hourRows.forEach((row) => {
        const hour = Number(row.hour);
        if (hourly[hour]) hourly[hour].total = Number(row.total || 0);
      });

      const [failedRows] = await connection.query(
        `SELECT
            CASE
              WHEN response IS NULL OR response = '' THEN 'Tanpa response'
              WHEN response LIKE '%opt%in%' OR response LIKE '%Opt-In%' THEN 'Opt-In'
              WHEN response LIKE '%not connected%' OR response LIKE '%Session not found%' THEN 'Device/session'
              WHEN response LIKE '%Invalid%' THEN 'Nomor/format invalid'
              WHEN response LIKE '%limit%' THEN 'Limit'
              ELSE LEFT(response, 80)
            END AS reason,
            COUNT(*) AS total
         FROM messages m
         JOIN devices d ON d.id = m.device_id AND d.status != 'deleted'
         WHERE m.uid = ?
           AND m.status = 'failed'
           AND m.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
         GROUP BY reason
         ORDER BY total DESC
         LIMIT 5`,
        [uid],
      );

      return {
        week,
        hourly,
        failedReasons: failedRows || [],
      };
    } catch (error) {
      console.error("Error retrieving message insights:", error);
      throw error.isBoom
        ? error
        : new Boom("Database error", { statusCode: 500 });
    } finally {
      connection.release();
    }
  }

  /**
   * Checks if a number is allowed to receive messages based on Opt-In rules
   * @param {number} uid User ID
   * @param {string} number Phone number
   * @param {string} tags Optional tags (e.g. 'opt-in' to allow invitations)
   * @returns {Promise<{allowed: boolean, reason: string}>}
   */
  async checkOptInStatus(uid, number, tags = "", force = false) {
    if (!force && String(process.env.FEATURE_OPT_IN) !== "1") {
      return { allowed: true, reason: "" };
    }

    const cleanJid = String(number || "").replace(/:[0-9]+/, "");
    const cleanNumber = cleanJid.split("@")[0].replace(/\D/g, "");

    // 1. Ambil semua identitas yang terkait (LID <-> Phone) dari tabel contacts
    const associatedNumbers = [cleanNumber];
    const [linked] = await this.pool.query(
      `SELECT jid, phone
       FROM contacts
       WHERE uid = ?
         AND (
           phone = ?
           OR jid LIKE ?
           OR REPLACE(SUBSTRING_INDEX(jid, '@', 1), ':', '') = ?
         )`,
      [uid, cleanNumber, `%${cleanNumber}%`, cleanNumber],
    );

    linked.forEach((l) => {
      if (l.phone) associatedNumbers.push(l.phone.replace(/\D/g, ""));
      if (l.jid) associatedNumbers.push(l.jid.replace(/\D/g, ""));
      if (l.jid) {
        const jidIdentity = l.jid
          .replace(/:[0-9]+/, "")
          .split("@")[0]
          .replace(/\D/g, "");
        associatedNumbers.push(jidIdentity);
      }
    });

    // Unique list of numbers to check
    const uniqueNumbers = [...new Set(associatedNumbers)].filter(
      (n) => n.length > 0,
    );

    // 2. Cek status di tabel opt_ins untuk semua nomor yang terkait
    // Urutkan status agar 'approved' diprioritaskan
      const [optRows] = await this.pool.query(
        "SELECT status FROM opt_ins WHERE uid = ? AND number IN (?) ORDER BY FIELD(status, 'approved', 'blocked', 'pending') LIMIT 1",
        [uid, uniqueNumbers],
      );

    const status = optRows.length > 0 ? optRows[0].status : "pending";
    const effectiveTag = (tags || "").toString().trim().toLowerCase();

    if (status === "approved") {
      return { allowed: true, reason: "" };
    }

    // If the message is tagged as an opt-in invitation, allow it even if pending or blocked
    if (effectiveTag === "opt-in") {
      return { allowed: true, reason: "" };
    }

    if (status === "pending") {
      return {
        allowed: false,
        reason: "Penerima belum melakukan Opt-In (Persetujuan).",
      };
    }

    return {
      allowed: false,
      reason: "Penerima telah memblokir/unsubs notifikasi.",
    };
  }

  async registerMessage(apiKey, deviceKey, messageData) {
    const connection = await this.pool.getConnection();
    try {
      // Cek user
      const [users] = await connection.query(
        "SELECT uid FROM users WHERE api_key = ? LIMIT 1",
        [apiKey],
      );
      if (users.length === 0) {
        return {
          status: false,
          message: "Invalid API key",
        };
      }
      const uid = users[0].uid;

      // Cek device milik sendiri atau device yang dibagikan ke akun ini.
      const [devices] = await connection.query(
        `SELECT
            d.id,
            COALESCE(ds.limit_daily_override, d.limit_daily) AS limit_daily,
            d.uid AS owner_uid,
            CASE WHEN d.uid = ? THEN 'owner' ELSE 'shared' END AS access_type
         FROM devices d
         LEFT JOIN device_shares ds
           ON ds.device_id = d.id
          AND ds.shared_uid = ?
          AND ds.status = 'active'
          AND ds.permission_send = 1
          AND (ds.expires_at IS NULL OR ds.expires_at > NOW())
         WHERE (d.uid = ? OR ds.id IS NOT NULL)
           AND d.device_key = ?
           AND d.status != 'deleted'
         LIMIT 1`,
        [uid, uid, uid, deviceKey],
      );
      if (devices.length === 0) {
        return {
          status: false,
          message: "Invalid Device Key or device is not shared to this account",
        };
      }
      const deviceId = devices[0].id;
      const limitDaily = devices[0].limit_daily || 0;

      // Hitung pesan hari ini
      const today = moment().tz("Asia/Jakarta").format("YYYY-MM-DD");

      let effectiveDeviceId = deviceId;
      let effectiveDeviceKey = deviceKey;
      let effectiveLimitDaily = limitDaily;

      // Check if primary is disconnected or limited
      const primarySession = this.sessionManager.getSession(deviceKey);
      const isPrimaryConnected = primarySession && primarySession.connected;
      const usedToday = await this.getDeviceUsageToday(connection, deviceId, today);
      const isPrimaryLimited =
        limitDaily > 0 && usedToday >= limitDaily;

      if (!isPrimaryConnected || isPrimaryLimited) {
        console.log(
          `ℹ️ [Fallback] Primary device ${deviceKey} is ${
            !isPrimaryConnected ? "disconnected" : "limited"
          }. Searching for sub-sessions...`,
        );

        // Find active sub-sessions
        const [subDevices] = await connection.query(
          "SELECT id, device_key, limit_daily FROM devices WHERE uid = ? AND session_parent = ? AND status = 'connected'",
          [devices[0].owner_uid, deviceKey],
        );

        for (const sub of subDevices) {
          const [subCount] = await connection.query(
            "SELECT COUNT(*) as total FROM messages WHERE device_id = ? AND DATE(created_at) = ?",
            [sub.id, today],
          );

          if (sub.limit_daily === 0 || subCount[0].total < sub.limit_daily) {
            effectiveDeviceId = sub.id;
            effectiveDeviceKey = sub.device_key;
            effectiveLimitDaily = sub.limit_daily;
            console.log(
              `✅ [Fallback] Using sub-session ${effectiveDeviceKey} (ID: ${effectiveDeviceId})`,
            );
            break;
          }
        }

        if (effectiveDeviceId === deviceId) {
          if (isPrimaryLimited) {
            return {
              status: false,
              message: `Daily message limit reached (${limitDaily}) for device ${deviceKey} and no active sub-sessions available`,
              limit: limitDaily,
              used: usedToday,
            };
          }
        }
      }

      // --- MESSAGE DATA PREPARATION ---
      let { isGroup, to, text, tags, tag, scheduledAt, scheduled_at, campaignId, campaign_id } = messageData;
      tags = tags || tag || "";
      campaignId = campaignId || campaign_id || null;

      const rawScheduledAt = scheduledAt || scheduled_at || null;
      let scheduledAtValue = null;
      if (rawScheduledAt) {
        const parsedSchedule = moment.tz(rawScheduledAt, "Asia/Jakarta");
        if (parsedSchedule.isValid()) {
          scheduledAtValue = parsedSchedule.format("YYYY-MM-DD HH:mm:ss");
        }
      }

      let type = "personal";
      if (isGroup) {
        type = "group";
      } else {
        // Normalize numbers to 628 format if they start with 08 or 0
        to = to
          .split(",")
          .map((num) => {
            let n = num.trim().replace(/\D/g, "");
            if (n.startsWith("08")) n = "628" + n.slice(2);
            else if (n.startsWith("0")) n = "62" + n.slice(1);
            return n;
          })
          .join(",");

        const recipients = to.split(",");
        if (recipients.length > 1) {
          type = "bulk";
        }
      }

      const effectiveTag = (tags || "").toString().trim().toLowerCase();
      if (type !== "group" && effectiveTag !== "opt-in") {
        const recipients = to
          .split(",")
          .map((num) => num.trim())
          .filter(Boolean);

        for (const recipient of recipients) {
          const optCheck = await this.checkOptInStatus(uid, recipient, "", true);
          if (
            !optCheck.allowed &&
            optCheck.reason.includes("memblokir")
          ) {
            return {
              status: false,
              message: `Nomor ${recipient} menolak/blokir Opt-In, pesan tidak dimasukkan ke antrean.`,
            };
          }
        }
      }
      // ---------------------------------

      const requestedRecipients = this.countRecipients(to);
      await connection.beginTransaction();
      const reservation = await this.reserveDeviceDailyLimit(
        connection,
        effectiveDeviceId,
        effectiveLimitDaily,
        today,
        requestedRecipients,
      );
      if (!reservation.allowed) {
        await connection.rollback();
        return {
          status: false,
          message: `Batas aman device ${effectiveDeviceKey} tersisa ${reservation.remaining}/${reservation.safeLimit} pesan (paket ${reservation.limit}, proteksi ${reservation.safePercent}%). Request ini butuh ${reservation.requested} pesan, jadi ditahan agar WhatsApp tidak makin terlimit.`,
          limit: reservation.limit,
          safeLimit: reservation.safeLimit,
          safePercent: reservation.safePercent,
          used: reservation.used,
          remaining: reservation.remaining,
          requested: reservation.requested,
        };
      }

      // Waktu sekarang
      const createdAt = moment()
        .tz("Asia/Jakarta")
        .format("YYYY-MM-DD HH:mm:ss");

      // Insert pesan
      const [result] = await connection.query(
        "INSERT INTO messages (uid, device_id, type, number, message, recipient_count, tags, campaign_id, scheduled_at, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          uid,
          effectiveDeviceId,
          type,
          to,
          text,
          requestedRecipients,
          tags,
          campaignId ? parseInt(campaignId) : null,
          scheduledAtValue,
          createdAt,
        ],
      );
      await connection.commit();

      return {
        status: true,
        message: "Message registered successfully",
        messageId: result.insertId,
      };
    } catch (error) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        // Ignore rollback errors when no transaction is active.
      }
      console.error("Error registering message:", error);
      return {
        status: false,
        message: "Database error",
      };
    } finally {
      connection.release();
    }
  }

  async removeMessage(apiKey, id) {
    const connection = await this.pool.getConnection();
    try {
      const [user] = await connection.query(
        "SELECT uid FROM users WHERE api_key = ?",
        [apiKey],
      );

      if (!user[0]) throw new Boom("Invalid API key", { statusCode: 401 });

      const [result] = await connection.query(
        "DELETE FROM messages WHERE uid = ? AND id = ?",
        [user[0].uid, id],
      );

      if (result.affectedRows === 0) {
        throw new Boom("Message not found", { statusCode: 404 });
      }

      return { status: true };
    } catch (error) {
      console.error("Error removing message:", error);
      throw error.isBoom
        ? error
        : new Boom("Database error", { statusCode: 500 });
    } finally {
      connection.release();
    }
  }

  async getOptIns(uid) {
    try {
      const [rows] = await this.pool.query(
        "SELECT o.*, d.name as device_name FROM opt_ins o LEFT JOIN devices d ON o.device_id = d.id WHERE o.uid = ? ORDER BY o.updated_at DESC",
        [uid],
      );
      return rows;
    } catch (error) {
      console.error("Error fetching opt-ins:", error);
      throw error;
    }
  }

  async syncOptInsFromInbox(uid) {
    try {
      const [approvedResult] = await this.pool.query(
        `
          INSERT INTO opt_ins (uid, device_id, number, status, source, agreed_at)
          SELECT
            im.uid,
            im.device_id,
            COALESCE(
              NULLIF(REPLACE(REPLACE(REPLACE(c.phone, '+', ''), ' ', ''), '-', ''), ''),
              SUBSTRING_INDEX(SUBSTRING_INDEX(im.remote_jid, ':', 1), '@', 1)
            ) AS number,
            'approved',
            'chat_explicit',
            COALESCE(im.received_at, NOW())
          FROM inbox_messages im
          LEFT JOIN contacts c
            ON c.uid = im.uid
           AND c.jid = CASE
             WHEN im.remote_jid LIKE '%:%'
               THEN CONCAT(SUBSTRING_INDEX(im.remote_jid, ':', 1), '@', SUBSTRING_INDEX(im.remote_jid, '@', -1))
             ELSE im.remote_jid
           END
          WHERE im.uid = ?
            AND im.from_me = 0
            AND im.is_group = 0
            AND LOWER(TRIM(im.message)) IN ('setuju', 'srtuju', 'stuju', 'saya setuju', 'aktifkan notifikasi', 'daftar notifikasi')
            AND im.remote_jid IS NOT NULL
            AND im.remote_jid != ''
            AND NOT EXISTS (
              SELECT 1 FROM opt_in_deleted oid
              WHERE oid.uid = im.uid
                AND oid.number = COALESCE(
                  NULLIF(REPLACE(REPLACE(REPLACE(c.phone, '+', ''), ' ', ''), '-', ''), ''),
                  SUBSTRING_INDEX(SUBSTRING_INDEX(im.remote_jid, ':', 1), '@', 1)
                )
            )
          ON DUPLICATE KEY UPDATE
            status = VALUES(status),
            source = VALUES(source),
            device_id = VALUES(device_id),
            agreed_at = COALESCE(opt_ins.agreed_at, VALUES(agreed_at)),
            system_blocked_at = NULL,
            block_reason = NULL,
            updated_at = NOW()
        `,
        [uid],
      );

      const [blockedResult] = await this.pool.query(
        `
          INSERT INTO opt_ins (uid, device_id, number, status, source, agreed_at)
          SELECT
            im.uid,
            im.device_id,
            COALESCE(
              NULLIF(REPLACE(REPLACE(REPLACE(c.phone, '+', ''), ' ', ''), '-', ''), ''),
              SUBSTRING_INDEX(SUBSTRING_INDEX(im.remote_jid, ':', 1), '@', 1)
            ) AS number,
            'blocked',
            'chat_explicit',
            NULL
          FROM inbox_messages im
          LEFT JOIN contacts c
            ON c.uid = im.uid
           AND c.jid = CASE
             WHEN im.remote_jid LIKE '%:%'
               THEN CONCAT(SUBSTRING_INDEX(im.remote_jid, ':', 1), '@', SUBSTRING_INDEX(im.remote_jid, '@', -1))
             ELSE im.remote_jid
           END
          WHERE im.uid = ?
            AND im.from_me = 0
            AND im.is_group = 0
            AND (
              LOWER(TRIM(im.message)) IN ('stop', 'berhenti', 'tidak setuju', 'unsubs', 'blokir')
              OR LOWER(im.message) LIKE '%tidak setuju%'
            )
            AND im.remote_jid IS NOT NULL
            AND im.remote_jid != ''
            AND NOT EXISTS (
              SELECT 1 FROM opt_in_deleted oid
              WHERE oid.uid = im.uid
                AND oid.number = COALESCE(
                  NULLIF(REPLACE(REPLACE(REPLACE(c.phone, '+', ''), ' ', ''), '-', ''), ''),
                  SUBSTRING_INDEX(SUBSTRING_INDEX(im.remote_jid, ':', 1), '@', 1)
                )
            )
          ON DUPLICATE KEY UPDATE
            status = VALUES(status),
            source = VALUES(source),
            device_id = VALUES(device_id),
            agreed_at = NULL,
            system_blocked_at = NULL,
            block_reason = NULL,
            updated_at = NOW()
        `,
        [uid],
      );

      return {
        approved: approvedResult.affectedRows || 0,
        blocked: blockedResult.affectedRows || 0,
      };
    } catch (error) {
      console.error("Error syncing opt-ins from inbox:", error);
      return { approved: 0, blocked: 0, error: error.message };
    }
  }

  async removeOptIn(uid, id) {
    try {
      const [rows] = await this.pool.query(
        "SELECT uid, device_id, number FROM opt_ins WHERE uid = ? AND id = ? LIMIT 1",
        [uid, id],
      );
      if (!rows.length) return false;

      await this.pool.query(
        `INSERT INTO opt_in_deleted (uid, device_id, number, deleted_at)
         VALUES (?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE device_id = VALUES(device_id), deleted_at = NOW()`,
        [uid, rows[0].device_id || 0, rows[0].number],
      );

      const [result] = await this.pool.query(
        "DELETE FROM opt_ins WHERE uid = ? AND id = ?",
        [uid, id],
      );
      return result.affectedRows > 0;
    } catch (error) {
      console.error("Error removing opt-in:", error);
      throw error;
    }
  }

  async registerOptIn(apiKey, number, status = "approved", source = "form") {
    const connection = await this.pool.getConnection();
    try {
      const [users] = await connection.query(
        "SELECT uid FROM users WHERE api_key = ? LIMIT 1",
        [apiKey],
      );
      if (users.length === 0) {
        return { status: false, message: "Invalid API key" };
      }
      const uid = users[0].uid;
      const cleanNumber = number.replace(/\D/g, "");
      const agreedAt = status === "approved" ? "NOW()" : "NULL";

      await connection.query(
        "DELETE FROM opt_in_deleted WHERE uid = ? AND number = ?",
        [uid, cleanNumber],
      );

      await connection.query(
        "INSERT INTO opt_ins (uid, device_id, number, status, source, agreed_at) VALUES (?, 0, ?, ?, ?, " +
          agreedAt +
          ") ON DUPLICATE KEY UPDATE status=VALUES(status), source=VALUES(source), agreed_at=VALUES(agreed_at), updated_at=NOW()",
        [uid, cleanNumber, status, source],
      );

      return { status: true, message: "Opt-In recorded successfully" };
    } catch (error) {
      console.error("Error registering opt-in:", error);
      return { status: false, message: "Database error" };
    } finally {
      connection.release();
    }
  }

  async retryMessage(apiKey, id, deviceKey = null) {
    const connection = await this.pool.getConnection();
    try {
      // Validasi API key
      const [users] = await connection.query(
        "SELECT uid FROM users WHERE api_key = ? LIMIT 1",
        [apiKey],
      );
      if (users.length === 0) {
        throw Boom.unauthorized("Invalid API key");
      }
      const uid = users[0].uid;

      // Cek apakah pesan ditemukan dan milik user
      const [messages] = await connection.query(
        "SELECT id, status FROM messages WHERE uid = ? AND id = ? LIMIT 1",
        [uid, id],
      );
      if (messages.length === 0) {
        throw Boom.notFound("Message not found");
      }

      const message = messages[0];

      if (!["failed", "pending", "processing"].includes(message.status)) {
        throw Boom.badRequest(
          `Message cannot be retried because its status is '${message.status}'`,
        );
      }

      let targetDeviceId = null;
      if (deviceKey) {
        const [devices] = await connection.query(
          `SELECT d.id
           FROM devices d
           LEFT JOIN device_shares ds
             ON ds.device_id = d.id
            AND ds.shared_uid = ?
            AND ds.status = 'active'
            AND ds.permission_send = 1
            AND (ds.expires_at IS NULL OR ds.expires_at > NOW())
           WHERE (d.uid = ? OR ds.id IS NOT NULL)
             AND d.device_key = ?
             AND d.status = 'connected'
           LIMIT 1`,
          [uid, uid, deviceKey],
        );
        if (devices.length === 0) {
          throw Boom.badRequest("Device tujuan tidak valid, tidak connected, atau tidak dapat diakses.");
        }
        targetDeviceId = devices[0].id;
      }

      const updatedAt = moment()
        .tz("Asia/Jakarta")
        .format("YYYY-MM-DD HH:mm:ss");

      // Update status menjadi pending untuk retry
      if (targetDeviceId) {
        await connection.query(
          "UPDATE messages SET status = ?, device_id = ?, response = NULL, updated_at = ? WHERE uid = ? AND id = ?",
          ["pending", targetDeviceId, updatedAt, uid, id],
        );
      } else {
        await connection.query(
          "UPDATE messages SET status = ?, response = NULL, updated_at = ? WHERE uid = ? AND id = ?",
          ["pending", updatedAt, uid, id],
        );
      }

      return {
        status: true,
        message: "Message status updated to pending for retry",
      };
    } catch (error) {
      console.error("Error confirming retry:", error);
      throw error.isBoom ? error : Boom.internal("Unexpected database error");
    } finally {
      connection.release();
    }
  }

  async getMessageCounts(apiKey) {
    const connection = await this.pool.getConnection();
    try {
      const [users] = await connection.query(
        "SELECT uid FROM users WHERE api_key = ? LIMIT 1",
        [apiKey],
      );
      if (users.length === 0) {
        throw new Boom("Invalid API key", { statusCode: 401 });
      }
      const userId = users[0].uid;

      const [messageCounts] = await connection.query(
        "SELECT status, COUNT(*) AS count FROM messages WHERE uid = ? GROUP BY status",
        [userId],
      );

      const counts = {};
      messageCounts.forEach((row) => {
        counts[row.status] = row.count;
      });

      const defaultStatuses = ["sent", "pending", "failed", "processing"];
      defaultStatuses.forEach((status) => {
        counts[status] = counts[status] || 0;
      });

      return counts;
    } catch (error) {
      console.log("Error retrieving message counts:");
      throw error.isBoom
        ? error
        : new Boom("Database error", { statusCode: 500 });
    } finally {
      connection.release();
    }
  }

  async getMessageCountTodayByDevice(apiKey, deviceKey) {
    const connection = await this.pool.getConnection();
    try {
      // Validasi API key
      const [users] = await connection.query(
        "SELECT uid FROM users WHERE api_key = ? LIMIT 1",
        [apiKey],
      );

      if (users.length === 0) {
        throw new Boom("Invalid API key", { statusCode: 401 });
      }

      const userId = users[0].uid;

      // Ambil ID device
      const [devices] = await connection.query(
        "SELECT id FROM devices WHERE uid = ? AND device_key = ? LIMIT 1",
        [userId, deviceKey],
      );

      if (devices.length === 0) {
        throw new Boom("Invalid device key", { statusCode: 404 });
      }

      const deviceId = devices[0].id;

      // Hitung pesan hari ini per status
      const [messageCounts] = await connection.query(
        `SELECT status, COUNT(*) AS count 
       FROM messages 
       WHERE uid = ? 
         AND device_id = ? 
         AND DATE(created_at) = CURDATE() 
       GROUP BY status`,
        [userId, deviceId],
      );

      const counts = {};
      messageCounts.forEach((row) => {
        counts[row.status] = row.count;
      });

      // Pastikan semua status ada
      const defaultStatuses = ["sent", "pending", "failed", "processing"];
      defaultStatuses.forEach((status) => {
        counts[status] = counts[status] || 0;
      });

      return counts;
    } catch (error) {
      console.error(
        "Error retrieving today's message counts by device:",
        error,
      );
      throw error.isBoom
        ? error
        : new Boom("Database error", { statusCode: 500 });
    } finally {
      connection.release();
    }
  }

  async sendMessage(
    apiKey,
    deviceKey,
    to,
    text,
    group = false,
    tags = "",
    options = {},
  ) {
    const session = this.sessionManager.getSession(deviceKey);
    if (!session || !session.connected) {
      throw new Error("Session not found or not connected.");
    }

    const [users] = await this.pool.query(
      "SELECT uid FROM users WHERE api_key = ? LIMIT 1",
      [apiKey],
    );
    if (!users.length) {
      throw new Error("Invalid API key.");
    }
    const uid = users[0].uid;

    const [devices] = await this.pool.query(
      `SELECT
          d.id,
          COALESCE(ds.limit_daily_override, d.limit_daily) AS limit_daily,
          d.uid AS owner_uid,
          CASE WHEN d.uid = ? THEN 'owner' ELSE 'shared' END AS access_type
       FROM devices d
       LEFT JOIN device_shares ds
         ON ds.device_id = d.id
        AND ds.shared_uid = ?
        AND ds.status = 'active'
        AND ds.permission_send = 1
        AND (ds.expires_at IS NULL OR ds.expires_at > NOW())
       WHERE (d.uid = ? OR ds.id IS NOT NULL)
         AND d.device_key = ?
         AND d.status != 'deleted'
       LIMIT 1`,
      [uid, uid, uid, deviceKey],
    );
    if (!devices.length) {
      throw new Error("Device not found or not shared to this account.");
    }
    const deviceId = devices[0].id;
    const limitDaily = Number(devices[0].limit_daily || 0);
    const today = moment().tz("Asia/Jakarta").format("YYYY-MM-DD");
    const createdAt = moment()
      .tz("Asia/Jakarta")
      .format("YYYY-MM-DD HH:mm:ss");

    const shouldRecordDirect = Boolean(options.recordDirect);
    let usedToday = 0;
    const safeLimitDaily =
      limitDaily > 0
        ? Math.max(1, Math.floor((limitDaily * this.safeDailyPercent) / 100))
        : 0;
    if (shouldRecordDirect) {
      const [dailyRows] = await this.pool.query(
        `SELECT COALESCE(SUM(
            COALESCE(NULLIF(recipient_count, 0), 1 + LENGTH(COALESCE(number, '')) - LENGTH(REPLACE(COALESCE(number, ''), ',', '')))
          ), 0) AS total
         FROM messages
         WHERE device_id = ? AND DATE(created_at) = ?`,
        [deviceId, today],
      );
      usedToday = Number(dailyRows[0]?.total || 0);
    }

    const recipients = to.split(",").map((recipient) => recipient.trim());
    const invalidRecipients = [];
    const results = [];
    const messageType = group ? "group" : recipients.length > 1 ? "bulk" : "personal";

    const recordDirectMessage = async (recipient, messageText, status, response = "") => {
      try {
        await this.pool.query(
          `INSERT INTO messages
             (uid, device_id, type, number, message, recipient_count, tags, status, response, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            uid,
            deviceId,
            messageType,
            recipient,
            messageText,
            1,
            tags,
            status,
            response,
            createdAt,
            createdAt,
          ],
        );
        usedToday += 1;
      } catch (error) {
        console.error("Failed to record direct message:", error.message);
      }
    };

    for (const recipient of recipients) {
      try {
        const renderedText = this.renderRecipientTemplate(text, recipient);
        if (shouldRecordDirect && safeLimitDaily > 0 && usedToday >= safeLimitDaily) {
          const message = `Batas aman harian tercapai (${usedToday}/${safeLimitDaily}, paket ${limitDaily}, proteksi ${this.safeDailyPercent}%) untuk device ${deviceKey}.`;
          results.push({
            recipient,
            status: false,
            message,
          });
          continue;
        }

if (group) {
            if (!isValidGroupId(recipient)) {
              invalidRecipients.push(recipient);
              results.push({
                recipient,
                status: false,
                message: "Invalid Group ID format.",
              });
              if (shouldRecordDirect) {
                await recordDirectMessage(recipient, renderedText, "failed", "Invalid Group ID format.");
              }
              continue;
            }
            await this.sessionManager.throttleSend(deviceKey);
            const groupSent = await session.socket.sendMessage(recipient, { text: renderedText });
            this.sessionManager.rememberSentMessage?.(groupSent);
            results.push({
              recipient,
              status: true,
              message: "Message sent successfully.",
            });
          if (shouldRecordDirect) {
            await recordDirectMessage(recipient, renderedText, "sent", "Message sent directly.");
          }
        } else {
          // --- OPT-IN CHECK ---
          const optCheck = await this.checkOptInStatus(uid, recipient, tags);
          if (!optCheck.allowed) {
            results.push({
              recipient,
              status: false,
              message: optCheck.reason,
            });
            if (shouldRecordDirect) {
              await recordDirectMessage(recipient, renderedText, "failed", optCheck.reason);
            }
            continue;
          }
          // --------------------

          if (!isValidPhoneNumber(recipient)) {
            invalidRecipients.push(recipient);
            results.push({
              recipient,
              status: false,
              message: "Invalid phone number format.",
            });
            if (shouldRecordDirect) {
              await recordDirectMessage(recipient, renderedText, "failed", "Invalid phone number format.");
            }
            continue;
          }

          const formattedNumber = recipient.includes("@s.whatsapp.net")
            ? recipient
            : `${recipient}@s.whatsapp.net`;

          await this.sessionManager.throttleSend(deviceKey);
          const sentMsg = await session.socket.sendMessage(formattedNumber, {
            text: renderedText,
          });
          this.sessionManager.rememberSentMessage?.(sentMsg);
          const resultJid = sentMsg.key.remoteJid;

          // Record mapping if it's a new JID or LID
          if (resultJid) {
            try {
              let cleanPhone = recipient.replace(/\D/g, "");
              if (cleanPhone.startsWith("08")) {
                cleanPhone = "628" + cleanPhone.slice(2);
              } else if (cleanPhone.startsWith("0")) {
                cleanPhone = "62" + cleanPhone.slice(1);
              }
              await this.pool.query(
                "INSERT INTO contacts (uid, device_id, jid, phone) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE phone = VALUES(phone), updated_at = NOW()",
                [uid, deviceId, resultJid, cleanPhone],
              );
            } catch (e) {
              // Ignore mapping errors
            }
          }

          results.push({
            recipient,
            status: true,
            message: "Message sent successfully.",
            messageId: sentMsg.key.id,
          });
          if (shouldRecordDirect) {
            await recordDirectMessage(
              recipient,
              renderedText,
              "sent",
              sentMsg.key.id ? `Message sent directly: ${sentMsg.key.id}` : "Message sent directly.",
            );
          }
        }
      } catch (error) {
        results.push({
          recipient,
          status: false,
          message: `Failed to send message: ${error.message}`,
        });
        if (shouldRecordDirect) {
          await recordDirectMessage(
            recipient,
            this.renderRecipientTemplate(text, recipient),
            "failed",
            `Failed to send message: ${error.message}`,
          );
        }
      }
    }

    return {
      status: true,
      message: "Message processing completed.",
      data: {
        results,
        invalidRecipients,
      },
    };
  }

  async getMessageStatistics(apiKey) {
    const connection = await this.pool.getConnection();
    try {
      const [users] = await connection.query(
        "SELECT uid FROM users WHERE api_key = ? LIMIT 1",
        [apiKey],
      );
      if (users.length === 0) {
        throw new Boom("Invalid API key", { statusCode: 401 });
      }
      const uid = users[0].uid;

      // Ambil data statistik berdasarkan status pesan
      const [statistics] = await connection.query(
        `SELECT status, COUNT(*) AS count 
                 FROM messages 
                 WHERE uid = ? AND created_at >= NOW() - INTERVAL 7 DAY 
                 GROUP BY status`,
        [uid],
      );

      // Ambil jumlah pesan per hari selama 7 hari terakhir
      const [dailyStats] = await connection.query(
        `SELECT DATE(created_at) AS date, 
                        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
                        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
                        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
                 FROM messages 
                 WHERE uid = ? AND created_at >= NOW() - INTERVAL 7 DAY 
                 GROUP BY DATE(created_at)
                 ORDER BY DATE(created_at) ASC`,
        [uid],
      );

      // Format statistik berdasarkan status
      const stats = {
        sent: 0,
        pending: 0,
        failed: 0,
        total: 0,
        daily: [],
      };

      statistics.forEach((row) => {
        stats[row.status] = row.count;
        stats.total += row.count;
      });

      // Format data harian untuk chart
      const formattedDailyStats = dailyStats.map((row) => ({
        date: row.date,
        sent: row.sent,
        pending: row.pending,
        failed: row.failed,
      }));

      stats.daily = formattedDailyStats;

      return stats;
    } catch (error) {
      console.error("Error retrieving message statistics:", error);
      throw error.isBoom
        ? error
        : new Boom("Database error", { statusCode: 500 });
    } finally {
      connection.release();
    }
  }

  async getMessagesLast(apiKey, limit = 3, days = 7) {
    const connection = await this.pool.getConnection();
    const now = moment().tz("Asia/Jakarta");
    const startTime = now.subtract(days, "days").format("YYYY-MM-DD HH:mm:ss"); // Ambil data 7 hari terakhir

    try {
      const [users] = await connection.query(
        "SELECT uid FROM users WHERE api_key = ? LIMIT 1",
        [apiKey],
      );

      if (users.length === 0) {
        throw new Boom("Invalid API key", { statusCode: 401 });
      }

      const uid = users[0].uid;

      const query = `
                SELECT m.id, m.uid, m.number, m.status, m.message, m.created_at, d.device_key
                FROM messages m 
                LEFT JOIN devices d ON d.id=m.device_id
                WHERE m.uid = ? AND m.created_at >= ? 
                ORDER BY m.created_at DESC 
                LIMIT ?
            `;

      const [messages] = await connection.query(query, [uid, startTime, limit]);

      return messages;
    } catch (error) {
      console.error("Error retrieving last messages:", error.message);
      throw new Error("Database error");
    } finally {
      connection.release(); // Pastikan koneksi selalu dilepas
    }
  }
}

module.exports = MessageManager;
