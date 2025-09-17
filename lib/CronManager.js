const cron = require("node-cron");
const moment = require("moment-timezone");

class CronManager {
  constructor(pool, messageManager, sessionManager) {
    this.pool = pool;
    this.messageManager = messageManager;
    this.sessionManager = sessionManager;

    // Flags untuk mencegah tumpang tindih
    this.cronProcessingFlags = {
      group: false,
      personal: false,
      bulk: false,
    };

    // Batas pesan harian per device (anti blokir)
    this.DAILY_MESSAGE_LIMIT = 250;

    // Konfigurasi delay (dalam ms)
    this.DELAY_BETWEEN_MESSAGES = { min: 5000, max: 15000 }; // 5-15 detik
    this.DELAY_BETWEEN_SESSIONS = { min: 10000, max: 30000 }; // 10-30 detik
    this.MICRO_SLEEP = { min: 30000, max: 60000 }; // 30-60 detik setiap 5 pesan
    this.MESSAGES_BEFORE_MICRO_SLEEP = 5;
  }

  async initCrons() {
    console.log("✅ Cron Manager initialized with anti-ban protection.");

    // === CRON UTAMA: Pengiriman Pesan (Hanya aktif jam 06:00 - 23:59) ===
    cron.schedule(
      "*/20 * 6-23 * * *", // Setiap 20 detik, jam 6 pagi - 11 malam
      async () => {
        const now = moment().tz("Asia/Jakarta");
        const hour = now.hour();
        
        // Double check: jangan kirim di luar jam operasional
        if (hour < 6 || hour >= 24) {
          console.log(`🌙 [Anti-Ban] Outside operational hours (${hour}:00). Skipping message processing.`);
          return;
        }

        for (const type of ["group", "personal", "bulk"]) {
          if (this.cronProcessingFlags[type]) {
            console.log(`⚠️ [${type}] already processing, skipping.`);
            continue;
          }

          this.cronProcessingFlags[type] = true;
          try {
            console.log(`🚀 Starting to process [${type}] messages...`);
            await this.processMessagesByType(type);
            console.log(`✅ Finished processing [${type}] messages.`);
          } catch (err) {
            console.error(`❌ Error in [${type}]:`, err.message);
          } finally {
            this.cronProcessingFlags[type] = false;
          }
        }
      },
      { timezone: "Asia/Jakarta" }
    );

    // === CRON: Kurangi life_time device (setiap jam 00:00) ===
    cron.schedule(
      "0 0 * * *", // Setiap jam 00:00
      async () => {
        console.log("🔁 [Cron] Decrementing device life_time...");
        await this.decrementDeviceLifeTime();
      },
      { timezone: "Asia/Jakarta" }
    );

    // === CRON: Notifikasi Deadline (setiap jam 09:00 & 15:00) ===
    cron.schedule(
      "0 9,15 * * *", // Jam 9 pagi dan 3 sore
      async () => {
        console.log("🔔 [Cron] Generating deadline warnings...");
        await this.generateDeadlineWarnings();
      },
      { timezone: "Asia/Jakarta" }
    );

    // === CRON: Bersihkan pesan lama (setiap jam 02:00) ===
    cron.schedule(
      "0 2 * * *", // Setiap jam 02:00
      async () => {
        console.log("🧹 [Cron] Cleaning up old messages...");
        await this.deleteOldMessages();
      },
      { timezone: "Asia/Jakarta" }
    );

    // === CRON: Hapus sesi device yang statusnya 'removed' (setiap 5 menit) ===
    cron.schedule(
      "*/5 * * * *",
      async () => {
        console.log("🗑️ [Cron] Removing sessions for 'removed' devices...");
        await this.removeRemovedDeviceSessions();
      },
      { timezone: "Asia/Jakarta" }
    );
  }

  // Hapus pesan lama dari database
  async deleteOldMessages() {
    const now = moment().tz("Asia/Jakarta");
    const oneMonthAgo = now.clone().subtract(1, "months").format("YYYY-MM-DD HH:mm:ss");
    const twoMonthsAgo = now.clone().subtract(2, "months").format("YYYY-MM-DD HH:mm:ss");

    try {
      const [sent] = await this.pool.query(
        `DELETE FROM messages WHERE status = 'sent' AND created_at < ?`,
        [oneMonthAgo]
      );
      console.log(`🗑️ Deleted ${sent.affectedRows} sent messages older than 1 month.`);

      const [others] = await this.pool.query(
        `DELETE FROM messages WHERE status IN ('pending', 'failed', 'processing') AND created_at < ?`,
        [twoMonthsAgo]
      );
      console.log(`🗑️ Deleted ${others.affectedRows} messages with other statuses older than 2 months.`);
    } catch (err) {
      console.error("❌ Failed to delete old messages:", err.message);
    }
  }

  // Ambil sesi aktif dengan pagination
  async fetchActiveSessions(limit, offset) {
    const sql = `
      SELECT u.uid, u.api_key, d.device_key, d.id AS device_id, d.name AS device_name, 
             d.phone AS device_phone, d.life_time
      FROM users u
      JOIN devices d ON u.uid = d.uid
      WHERE u.active = 1 AND d.status = 'connected'
      LIMIT ? OFFSET ?`;

    const [rows] = await this.pool.query(sql, [limit, offset]);

    return rows.map((row) => ({
      uid: row.uid,
      apiKey: row.api_key,
      deviceKey: row.device_key,
      deviceId: row.device_id,
      deviceName: row.device_name,
      devicePhone: row.device_phone,
      deviceLifeTime: row.life_time,
    }));
  }

  // Proses pesan berdasarkan tipe (group/personal/bulk)
  async processMessagesByType(type) {
    const SESSION_LIMIT = 10;
    let offset = 0;

    while (true) {
      const sessions = await this.fetchActiveSessions(SESSION_LIMIT, offset);
      if (sessions.length === 0) break;

      for (const session of sessions) {
        await this.processMessages(session, type);
        
        // Delay antar sesi (10-30 detik)
        const delayMs = this.DELAY_BETWEEN_SESSIONS.min + 
                       Math.floor(Math.random() * (this.DELAY_BETWEEN_SESSIONS.max - this.DELAY_BETWEEN_SESSIONS.min));
        await this.delay(delayMs);
      }

      offset += SESSION_LIMIT;
    }
  }

  // Proses pesan untuk satu sesi
  async processMessages(session, type) {
    if (!session || !type) return;

    const { uid, apiKey, deviceKey, deviceId } = session;
    const BATCH_LIMIT = 15; // Dari 50 jadi 15 (anti blokir)
    const now = moment().tz("Asia/Jakarta");
    const today = now.format("YYYY-MM-DD");
    const currentTime = now.format("YYYY-MM-DD HH:mm:ss");

    // Cek batas harian
    const [dailyCount] = await this.pool.query(
      `SELECT COUNT(*) as sentToday FROM messages WHERE device_id = ? AND status = 'sent' AND DATE(created_at) = ?`,
      [deviceId, today]
    );

    if (dailyCount[0].sentToday >= this.DAILY_MESSAGE_LIMIT) {
      console.log(`🚫 [Anti-Ban] Daily limit reached (${this.DAILY_MESSAGE_LIMIT}) for device ${deviceKey}. Skipping.`);
      return;
    }

    // Lock pesan
    await this.pool.query(
      `
      UPDATE messages 
      SET status = 'processing', updated_at = ? 
      WHERE status = 'pending' AND type = ? AND uid = ? 
        AND device_id = ? AND DATE(created_at) = ? 
      ORDER BY created_at ASC LIMIT ?`,
      [currentTime, type, uid, deviceId, today, BATCH_LIMIT]
    );

    // Ambil pesan yang dikunci
    const [messages] = await this.pool.query(
      `
      SELECT * FROM messages 
      WHERE status = 'processing' AND type = ? AND uid = ? 
        AND device_id = ? AND DATE(created_at) = ? 
      ORDER BY created_at ASC`,
      [type, uid, deviceId, today]
    );

    if (messages.length === 0) {
      console.log(`ℹ️ No pending messages for device ${deviceKey} (type: ${type})`);
      return;
    }

    let failedConsecutiveCount = 0;
    const MAX_CONSECUTIVE_FAILURES = 3;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      // Jika gagal berturut-turut > 3, hentikan
      if (failedConsecutiveCount >= MAX_CONSECUTIVE_FAILURES) {
        console.warn(`⚠️ [Anti-Ban] Too many consecutive failures (${MAX_CONSECUTIVE_FAILURES}). Pausing for device ${deviceKey}.`);
        break;
      }

      let { id, number, message, type: msgType } = msg;

      if (!number || !message) {
        console.warn(`⚠️ Skipping message ID ${id}: number or message missing`);
        continue;
      }

      // Validasi group
      if (msgType === "group" && !number.includes("@g.us")) {
        const [group] = await this.pool.query(
          "SELECT group_id FROM `groups` WHERE group_key = ? LIMIT 1",
          [number]
        );
        if (!group.length || !group[0].group_id) {
          console.warn(`⚠️ Group not found for message ID ${id}, key: ${number}`);
          await this.pool.query(
            "UPDATE messages SET status = ?, updated_at = ? WHERE id = ?",
            ["failed", currentTime, id]
          );
          failedConsecutiveCount++;
          continue;
        }
        number = group[0].group_id;
      }

      try {
        // Delay antar pesan (5-15 detik)
        const delayMs = this.DELAY_BETWEEN_MESSAGES.min + 
                       Math.floor(Math.random() * (this.DELAY_BETWEEN_MESSAGES.max - this.DELAY_BETWEEN_MESSAGES.min));
        await this.delay(delayMs);

        // Micro-sleep setiap 5 pesan
        if (i > 0 && i % this.MESSAGES_BEFORE_MICRO_SLEEP === 0) {
          const microSleepMs = this.MICRO_SLEEP.min + 
                              Math.floor(Math.random() * (this.MICRO_SLEEP.max - this.MICRO_SLEEP.min));
          console.log(`💤 [Anti-Ban] Micro-sleep for ${Math.round(microSleepMs/1000)} seconds...`);
          await this.delay(microSleepMs);
        }

        const response = await this.messageManager.sendMessage(
          apiKey,
          deviceKey,
          number,
          message,
          msgType === "group" ? 1 : 0
        );

        const status = response?.status && response?.data?.results?.every((r) => r.status)
          ? "sent"
          : "failed";

        await this.pool.query(
          `UPDATE messages SET status = ?, response = ?, updated_at = ? WHERE id = ?`,
          [status, JSON.stringify(response), currentTime, id]
        );

        if (status === "sent") {
          failedConsecutiveCount = 0; // Reset counter jika sukses
          console.log(`✅ Message ID ${id} sent successfully via device ${deviceKey}`);
        } else {
          failedConsecutiveCount++;
          console.warn(`⚠️ Message ID ${id} failed via device ${deviceKey}`);
        }

      } catch (err) {
        console.error(`❌ Failed to send message ID ${id}:`, err.message);
        await this.pool.query(
          "UPDATE messages SET status = ?, updated_at = ? WHERE id = ?",
          ["failed", currentTime, id]
        );
        failedConsecutiveCount++;
      }
    }
  }

  // Helper delay
  async delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Kurangi life_time device
  async decrementDeviceLifeTime() {
    try {
      const today = moment().tz("Asia/Jakarta").format("YYYY-MM-DD");
      const now = moment().tz("Asia/Jakarta").format("YYYY-MM-DD HH:mm:ss");

      const sql = `
      UPDATE devices 
      SET 
        life_time = life_time - 1,
        status = CASE 
          WHEN life_time - 1 <= 0 THEN 'removed'
          ELSE status 
        END,
        last_life_decrement = ?, 
        updated_at = ?
      WHERE 
        status = 'connected'
        AND life_time > 0
        AND (
          last_life_decrement IS NULL 
          OR last_life_decrement < ?
        )`;

      const [result] = await this.pool.query(sql, [today, now, today]);
      console.log(`[✅] Updated life_time for ${result.affectedRows} connected device(s).`);
    } catch (error) {
      console.error("❌ Error updating device life_time:", error.message);
    }
  }

  // Generate notifikasi deadline
  async generateDeadlineWarnings() {
    const limitSessions = 10;
    let offset = 0;

    const sessions = await this.fetchActiveSessions(limitSessions, offset);

    for (const session of sessions) {
      const {
        deviceLifeTime: diffInDays,
        apiKey,
        deviceKey,
        devicePhone,
        deviceId,
      } = session;
      let message = "";

      // Perbaikan: Hanya kirim notifikasi untuk 3, 2, 1, dan 0 hari
      switch (diffInDays) {
        case 3:
          message = `📢 Pemberitahuan: Masa aktif perangkat *${deviceKey}* pada layanan WhatsApp Gateway W@Pi akan berakhir dalam 3 hari.\n\nSegera lakukan top-up untuk memastikan layanan tetap berjalan tanpa gangguan.`;
          break;
        case 2:
          message = `⚠️ Peringatan: Masa aktif perangkat *${deviceKey}* akan berakhir dalam 2 hari.\n\nSilakan perpanjang masa layanan Anda sesegera mungkin untuk menghindari penghentian akses.`;
          break;
        case 1:
          message = `⏰ Peringatan Penting: Besok adalah hari terakhir masa aktif perangkat *${deviceKey}* pada layanan WhatsApp Gateway W@Pi.\n\nLakukan top-up sekarang untuk mencegah terputusnya layanan.`;
          break;
        case 0:
          message = `🚨 Hari Terakhir: Masa aktif perangkat *${deviceKey}* berakhir hari ini.\n\nSegera lakukan perpanjangan agar layanan Anda tidak terhenti.`;
          break;
        default:
          continue; // Skip jika bukan 3,2,1,0
      }

      if (message) {
        try {
          const hasSentToday = await this.hasSentWarningToday(deviceId);
          if (!hasSentToday) {
            // Perbaikan link sesuai knowledge base
            message += `\n\n🔗 Pilih paket perpanjangan: https://wapi.jasaedukasi.com/#pricing`;

            const messageData = {
              isGroup: 0,
              to: devicePhone,
              text: message,
              tags: "Life Time",
            };

            await this.messageManager.registerMessage(
              apiKey,
              deviceKey,
              messageData
            );
            console.log(`✅ [Notification] Warning sent for device "${deviceKey}" (Life: ${diffInDays} days)`);
          } else {
            console.log(`ℹ️ [Notification] Warning already sent today for device "${deviceKey}"`);
          }
        } catch (error) {
          console.error(`❌ [Notification] Failed to send warning for device "${deviceKey}":`, error.message);
        }
      }
    }
  }

  // Cek apakah notifikasi sudah dikirim hari ini
  async hasSentWarningToday(deviceId) {
    const sql = `SELECT COUNT(*) AS count FROM messages WHERE device_id = ? AND tags = 'Life Time' AND DATE(created_at) = CURDATE()`;
    const [rows] = await this.pool.query(sql, [deviceId]);
    return rows[0].count > 0;
  }

  // Hapus sesi untuk device yang statusnya 'removed'
  async removeRemovedDeviceSessions() {
    try {
      const now = moment().tz("Asia/Jakarta").format("YYYY-MM-DD HH:mm:ss");

      const sql = `SELECT device_key FROM devices WHERE status = 'removed'`;
      const [rows] = await this.pool.query(sql);

      let removedCount = 0;

      for (const row of rows) {
        const deviceKey = row.device_key;

        const removed = await this.sessionManager.removeSession(deviceKey, true);
        if (removed) {
          console.log(`[${now}] ✅ Session removed for device: ${deviceKey}`);
          removedCount++;
        }
      }

      console.log(`[${now}] 🗑️ Total ${removedCount} sessions removed for 'removed' devices.`);
    } catch (error) {
      console.error("❌ Error removing sessions for removed devices:", error.message);
    }
  }
}

module.exports = CronManager;