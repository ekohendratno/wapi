const cron = require("node-cron");
const moment = require("moment-timezone");

class CronManager {
  constructor(pool, messageManager, sessionManager, billingManager) {
    this.pool = pool;
    this.messageManager = messageManager;
    this.sessionManager = sessionManager;
    this.billingManager = billingManager;
    this.tasks = [];

    // Flags untuk mencegah overlap task
    this.cronProcessingFlags = {
      group: false,
      personal: false,
      bulk: false,
    };

    // Batas pesan harian per device (anti-blokir)
    this.DAILY_MESSAGE_LIMIT = 250;

    // Konfigurasi delay (anti-spam/ban)
    this.DELAY_BETWEEN_MESSAGES = { min: 5000, max: 15000 }; // 5–15s antar pesan
    this.DELAY_BETWEEN_SESSIONS = { min: 10000, max: 30000 }; // 10–30s antar sesi

    this.MESSAGES_BEFORE_MICRO_SLEEP = 10;
    this.MICRO_SLEEP = { min: 30000, max: 90000 }; // 30–90 detik
  }

  async initCrons() {
    console.log("✅ Cron Manager initialized with anti-ban strategies.");

    // === CRON UTAMA: Pengiriman pesan ===
    const mainTask = cron.schedule(
      "*/20 * 6-23 * * *", // setiap 20 detik, hanya jam 6–23
      async () => {
        const now = moment().tz("Asia/Jakarta");
        const hour = now.hour();

        if (hour < 6 || hour >= 24) {
          console.log(
            `🌙 [Anti-Ban] Skip sending outside operational hours (${hour}:00).`
          );
          return;
        }

        for (const type of ["group", "personal", "bulk"]) {
          if (this.cronProcessingFlags[type]) {
            console.log(`⚠️ [${type}] already processing, skip this tick.`);
            continue;
          }

          this.cronProcessingFlags[type] = true;
          try {
            console.log(`🚀 Processing [${type}] messages...`);
            await this.processMessagesByType(type);
          } catch (err) {
            console.error(`❌ Error in [${type}] process:`, err.message);
          } finally {
            this.cronProcessingFlags[type] = false;
          }
        }
      },
      { timezone: "Asia/Jakarta" }
    );
    this.tasks.push(mainTask);

    // === CRON LAIN ===
    const t1 = cron.schedule(
      "0 0 * * *",
      () => this.safeExec(this.decrementDeviceLifeTime, "Decrement life_time"),
      { timezone: "Asia/Jakarta" }
    );
    this.tasks.push(t1);
    const t2 = cron.schedule(
      "0 9,15 * * *",
      () => this.safeExec(this.generateDeadlineWarnings, "Deadline warning"),
      { timezone: "Asia/Jakarta" }
    );
    this.tasks.push(t2);
    const t3 = cron.schedule(
      "0 2 * * *",
      () => this.safeExec(this.deleteOldMessages, "Delete old messages"),
      { timezone: "Asia/Jakarta" }
    );
    this.tasks.push(t3);
    const t4 = cron.schedule(
      "*/1 * * * *",
      () =>
        this.safeExec(
          this.removeRemovedDeviceSessions,
          "Remove removed sessions"
        ),
      { timezone: "Asia/Jakarta" }
    );
    this.tasks.push(t4);

    // Check pending transactions and mark expired ones as failed (or update if paid)
    const t5 = cron.schedule(
      "*/5 * * * *",
      () =>
        this.safeExec(
          this.checkPendingTransactions,
          "Pending transactions check"
        ),
      { timezone: "Asia/Jakarta" }
    );
    this.tasks.push(t5);
  }

  async stop() {
    try {
      this.tasks.forEach((t) => t.stop && t.stop());
      this.tasks = [];
      console.log("✅ Cron Manager stopped.");
    } catch (err) {
      console.error("Failed to stop CronManager:", err && err.message);
    }
  }

  // Wrapper biar setiap cron aman (nggak bikin crash server)
  async safeExec(fn, label) {
    try {
      console.log(`⏳ [Cron] Running task: ${label}`);
      await fn.call(this);
      console.log(`✅ [Cron] Finished task: ${label}`);
    } catch (err) {
      console.error(`❌ [Cron] Error in task ${label}:`, err.message);
    }
  }

  // ====================== CLEANUP ======================

  async deleteOldMessages() {
    const now = moment().tz("Asia/Jakarta");
    const oneMonthAgo = now
      .clone()
      .subtract(1, "months")
      .format("YYYY-MM-DD HH:mm:ss");
    const twoMonthsAgo = now
      .clone()
      .subtract(2, "months")
      .format("YYYY-MM-DD HH:mm:ss");

    try {
      const [sent] = await this.pool.query(
        `DELETE FROM messages WHERE status = 'sent' AND created_at < ?`,
        [oneMonthAgo]
      );
      console.log(
        `🧹 Deleted ${sent.affectedRows} sent messages older than 1 month.`
      );

      const [others] = await this.pool.query(
        `DELETE FROM messages WHERE status IN ('pending','failed','processing') AND created_at < ?`,
        [twoMonthsAgo]
      );
      console.log(
        `🧹 Deleted ${others.affectedRows} stale messages older than 2 months.`
      );
    } catch (err) {
      console.error("❌ Cleanup failed:", err.message);
    }
  }

  // ====================== SESSION FETCH ======================

  async fetchActiveSessions(limit, offset) {
    const sql = `
      SELECT u.uid, u.api_key, d.device_key, d.id AS device_id, d.name AS device_name, 
             d.phone AS device_phone, d.life_time
      FROM users u
      JOIN devices d ON u.uid = d.uid
      WHERE u.active = 1 AND d.status = 'connected'
      LIMIT ? OFFSET ?`;

    const [rows] = await this.pool.query(sql, [limit, offset]);
    return rows.map((r) => ({
      uid: r.uid,
      apiKey: r.api_key,
      deviceKey: r.device_key,
      deviceId: r.device_id,
      deviceName: r.device_name,
      devicePhone: r.device_phone,
      deviceLifeTime: r.life_time,
    }));
  }

  // ====================== MESSAGE PROCESS ======================

  async processMessagesByType(type) {
    const SESSION_LIMIT = 10;
    let offset = 0;

    while (true) {
      const sessions = await this.fetchActiveSessions(SESSION_LIMIT, offset);
      if (!sessions.length) break;

      for (const session of sessions) {
        try {
          await this.processMessages(session, type);
        } catch (err) {
          console.error(
            `❌ Error processing ${type} for device ${session.deviceKey}:`,
            err.message
          );
        }

        await this.delay(this.randomDelay(this.DELAY_BETWEEN_SESSIONS));
      }

      offset += SESSION_LIMIT;
    }
  }

  async processMessages(session, type) {
    if (!session) return;

    const { uid, apiKey, deviceKey, deviceId } = session;
    const BATCH_LIMIT = 15;
    const now = moment().tz("Asia/Jakarta");
    const today = now.format("YYYY-MM-DD");
    const currentTime = now.format("YYYY-MM-DD HH:mm:ss");

    // Ambil limit harian dari DB
    let dailyLimit = this.DAILY_MESSAGE_LIMIT; // default 250
    try {
      const [rows] = await this.pool.query(
        "SELECT limit_daily FROM devices WHERE id=? LIMIT 1",
        [deviceId]
      );
      if (rows.length && rows[0].limit_daily > 0) {
        dailyLimit = rows[0].limit_daily;
      }
    } catch (err) {
      console.warn(
        `⚠️ Gagal ambil limit_daily device ${deviceKey}, pakai default ${this.DAILY_MESSAGE_LIMIT}`,
        err.message
      );
    }

    // Anti-spam: cek daily limit
    const [dailyCount] = await this.pool.query(
      `SELECT COUNT(*) AS sentToday FROM messages WHERE device_id = ? AND DATE(created_at) = ?`,
      [deviceId, today]
    );
    if (dailyCount[0].sentToday >= dailyLimit) {
      console.log(
        `🚫 [Anti-Ban] Limit reached (${dailyLimit}) for device ${deviceKey}`
      );
      return;
    }

    // Lock pesan
    await this.pool.query(
      `UPDATE messages SET status='processing', updated_at=? 
       WHERE status='pending' AND type=? AND uid=? AND device_id=? AND DATE(created_at)=? 
       ORDER BY created_at ASC LIMIT ?`,
      [currentTime, type, uid, deviceId, today, BATCH_LIMIT]
    );

    const [messages] = await this.pool.query(
      `SELECT * FROM messages WHERE status='processing' AND type=? AND uid=? AND device_id=? AND DATE(created_at)=? 
       ORDER BY created_at ASC`,
      [type, uid, deviceId, today]
    );
    if (!messages.length) return;

    let failedConsecutive = 0;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (failedConsecutive >= 3) {
        console.warn(`⚠️ Too many failures, pausing for device ${deviceKey}`);
        break;
      }

      let { id, number, message, type: msgType } = msg;
      if (!number || !message) continue;

      // Validasi group
      if (msgType === "group" && !number.includes("@g.us")) {
        const [group] = await this.pool.query(
          "SELECT group_id FROM `groups` WHERE group_key=? LIMIT 1",
          [number]
        );
        if (!group.length) {
          await this.pool.query(
            "UPDATE messages SET status='failed', updated_at=? WHERE id=?",
            [currentTime, id]
          );
          failedConsecutive++;
          continue;
        }
        number = group[0].group_id;
      }

      try {
        // 1. Initial random interval (Human pause between chats)
        await this.delay(this.randomDelay(this.DELAY_BETWEEN_MESSAGES));

        // 2. Micro-sleep for extensive batching
        if (i > 0 && i % this.MESSAGES_BEFORE_MICRO_SLEEP === 0) {
          console.log(
            `💤 [Anti-Ban] Micro-sleep triggered for device ${deviceKey}...`
          );
          await this.delay(this.randomDelay(this.MICRO_SLEEP));
        }

        // 3. Human-like Typing Simulation
        const realSession = this.sessionManager.getSession(deviceKey);
        if (realSession && realSession.socket) {
          try {
            // Start 'typing...'
            await realSession.socket.sendPresenceUpdate("composing", number);

            // Calculate typing duration based on message length (min 2s, max 10s)
            // Approx 100ms per character is a comfortable reading/typing speed simulation
            const typingDuration = Math.min(
              Math.max(message.length * 100, 2000),
              10000
            );
            await this.delay(typingDuration);

            // Stop 'typing...' (optional, sending msg usually stops it, but good practice)
            await realSession.socket.sendPresenceUpdate("paused", number);
          } catch (presenceErr) {
            // Ignore presence errors, don't fail the message
            // console.warn('Presence update failed:', presenceErr.message);
          }
        }

        const resp = await this.messageManager.sendMessage(
          apiKey,
          deviceKey,
          number,
          message,
          msgType === "group" ? 1 : 0
        );
        const ok = resp?.status && resp?.data?.results?.every((r) => r.status);
        const status = ok ? "sent" : "failed";

        await this.pool.query(
          "UPDATE messages SET status=?, response=?, updated_at=? WHERE id=?",
          [status, JSON.stringify(resp), currentTime, id]
        );

        if (ok) {
          failedConsecutive = 0;
          console.log(`✅ Sent message ${id} via ${deviceKey}`);
        } else {
          failedConsecutive++;
          console.warn(`⚠️ Failed sending message ${id} via ${deviceKey}`);
        }
      } catch (err) {
        console.error(`❌ Error sending ${id}:`, err.message);
        await this.pool.query(
          "UPDATE messages SET status='failed', updated_at=? WHERE id=?",
          [currentTime, id]
        );
        failedConsecutive++;
      }
    }
  }

  // ====================== DEVICE LIFETIME ======================

  async decrementDeviceLifeTime() {
    const today = moment().tz("Asia/Jakarta").format("YYYY-MM-DD");
    const now = moment().tz("Asia/Jakarta").format("YYYY-MM-DD HH:mm:ss");

    const sql = `
      UPDATE devices 
      SET life_time = life_time - 1,
          status = CASE WHEN life_time - 1 <= 0 THEN 'removed' ELSE status END,
          last_life_decrement=?, updated_at=?
      WHERE status='connected' AND life_time > 0 
        AND (last_life_decrement IS NULL OR last_life_decrement < ?)`;

    const [res] = await this.pool.query(sql, [today, now, today]);
    console.log(`🔁 Life_time decremented for ${res.affectedRows} devices.`);
  }

  // ====================== DEADLINE NOTIF ======================

  async generateDeadlineWarnings() {
    const sessions = await this.fetchActiveSessions(10, 0);
    for (const s of sessions) {
      const { deviceLifeTime, apiKey, deviceKey, devicePhone, deviceId } = s;
      let msg = "";

      switch (deviceLifeTime) {
        case 3:
          msg = `📢 Masa aktif perangkat *${deviceKey}* akan berakhir dalam 3 hari.`;
          break;
        case 2:
          msg = `⚠️ Masa aktif perangkat *${deviceKey}* tinggal 2 hari.`;
          break;
        case 1:
          msg = `⏰ Besok adalah hari terakhir masa aktif perangkat *${deviceKey}*.`;
          break;
        case 0:
          msg = `🚨 Masa aktif perangkat *${deviceKey}* berakhir hari ini.`;
          break;
      }
      if (!msg) continue;

      if (await this.hasSentWarningToday(deviceId)) continue;

      msg += `\n\n🔗 Perpanjangan: https://wapi.jasaedukasi.com/#pricing`;

      await this.messageManager.registerMessage(apiKey, deviceKey, {
        isGroup: 0,
        to: devicePhone,
        text: msg,
        tags: "Life Time",
      });
      console.log(
        `✅ Warning sent for ${deviceKey} (Life: ${deviceLifeTime} days)`
      );
    }
  }

  async hasSentWarningToday(deviceId) {
    const [rows] = await this.pool.query(
      "SELECT COUNT(*) AS c FROM messages WHERE device_id=? AND tags='Life Time' AND DATE(created_at)=CURDATE()",
      [deviceId]
    );
    return rows[0].c > 0;
  }

  // ====================== REMOVE SESSIONS ======================

  async removeRemovedDeviceSessions() {
    // Target devices that have been marked for final deletion by user/API
    const [rows] = await this.pool.query(
      "SELECT device_key FROM devices WHERE status='deleted'"
    );
    let count = 0;
    for (const r of rows) {
      const connection = await this.pool.getConnection();
      try {
        // Lookup device id first
        const [devRows] = await connection.query(
          "SELECT id FROM devices WHERE device_key = ? LIMIT 1",
          [r.device_key]
        );
        const deviceId = devRows.length ? devRows[0].id : null;

        // Remove session files first (best-effort)
        await this.sessionManager.removeSession(r.device_key, true);

        // Start DB transaction to remove related rows and device record atomically
        await connection.beginTransaction();

        // Delete messages for this device
        if (deviceId) {
          await connection.query("DELETE FROM messages WHERE device_id = ?", [
            deviceId,
          ]);
          await connection.query("DELETE FROM autoreply WHERE device_id = ?", [
            deviceId,
          ]);
        }

        // Groups use device_key
        await connection.query("DELETE FROM `groups` WHERE device_key = ?", [
          r.device_key,
        ]);

        // Finally delete device row
        await connection.query("DELETE FROM devices WHERE device_key = ?", [
          r.device_key,
        ]);

        await connection.commit();
        count++;
      } catch (err) {
        try {
          await connection.rollback();
        } catch (er) {
          /* ignore rollback error */
        }
        console.warn(
          `Failed to fully remove device ${r.device_key}:`,
          err && err.message
        );
      } finally {
        connection.release();
      }
    }
    console.log(
      `🗑️ Removed ${count} sessions for 'deleted' devices (finalized user deletions).`
    );
  }

  // ====================== TRANSACTION / PAYMENT CHECK ======================

  async checkPendingTransactions() {
    // expiry in minutes for pending invoices (default same as create-invoice expiry)
    const expiryMinutes = parseInt(
      process.env.DUITKU_EXPIRY_MINUTES || "10",
      10
    );
    const now = moment().tz("Asia/Jakarta");
    const cutoff = now
      .clone()
      .subtract(expiryMinutes, "minutes")
      .format("YYYY-MM-DD HH:mm:ss");

    console.log(
      `🔍 Checking pending transactions older than ${expiryMinutes} minutes (cutoff=${cutoff})`
    );

    try {
      const [rows] = await this.pool.query(
        `SELECT merchantOrderId, reference, amount, status, created_at FROM transactions WHERE status = 'pending' AND created_at <= ?`,
        [cutoff]
      );

      if (!rows.length) {
        console.log("✅ No expired pending transactions found.");
        return;
      }

      for (const tx of rows) {
        const { merchantOrderId } = tx;
        try {
          // Default behavior: mark as failed. If you want to query gateway first,
          // implement a call to Duitku inquiry API here and update accordingly.
          console.log(
            `⏳ Marking expired pending transaction ${merchantOrderId} -> failed`
          );
          if (
            this.billingManager &&
            typeof this.billingManager.updateTransactionStatus === "function"
          ) {
            await this.billingManager.updateTransactionStatus(
              merchantOrderId,
              "failed"
            );
          } else {
            await this.pool.query(
              `UPDATE transactions SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE merchantOrderId = ?`,
              [merchantOrderId]
            );
          }
        } catch (err) {
          console.error(
            `❌ Failed to update transaction ${merchantOrderId}:`,
            err && err.message
          );
        }
      }
    } catch (err) {
      console.error(
        "❌ Error checking pending transactions:",
        err && err.message
      );
    }
  }

  // ====================== UTIL ======================

  randomDelay(range) {
    return range.min + Math.floor(Math.random() * (range.max - range.min));
  }

  delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

module.exports = CronManager;
