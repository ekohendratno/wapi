const cron = require("node-cron");

class CronGroupManager {
  constructor(pool, sessionManager) {
    this.pool = pool;
    this.sessionManager = sessionManager;
    this.isProcessing = false;
  }

  async initCrons() {
    console.log("Initializing cron group jobs...");
    cron.schedule("*/1 * * * *", async () => {
      if (this.isProcessing) {
        console.log("Cron is still running, skipping this cycle...");
        return;
      }

      this.isProcessing = true;

      try {
        console.log(
          "Running cron job to fetch and insert groups with /register messages..."
        );
        const sessions = this.sessionManager.getAllSessions();

        for (const [deviceKey, session] of Object.entries(sessions)) {
          const did = session.device_id || 0;
          const uid = session.user_id || 0;

          try {
            const client = session.socket;

            if (!client) {
              console.log(`Device ${deviceKey} is not connected. Skipping...`);
              continue;
            }

            const participatingGroups =
              await client.groupFetchAllParticipating();
            console.log(
              `Found ${
                Object.keys(participatingGroups).length
              } groups for device ${deviceKey}`
            );

            for (const [groupId, groupData] of Object.entries(
              participatingGroups
            )) {
              try {
                const messages = await client.loadMessages(groupId, 50); // ambil 50 pesan terakhir

                // Temukan pesan terakhir yang mengandung /register
                const lastRegisterMessage = [...messages]
                  .reverse()
                  .find(
                    (msg) =>
                      typeof msg.message?.conversation === "string" &&
                      msg.message.conversation.trim().toLowerCase() ===
                        "/register"
                  );

                if (lastRegisterMessage) {
                  const cleanGroupId = groupId.replace("@g.us", "");
                  const groupName = groupData.subject || "Unknown Group";
                  const senderJid =
                    lastRegisterMessage.key.participant ||
                    lastRegisterMessage.key.remoteJid;
                  const timestamp =
                    lastRegisterMessage.messageTimestamp || new Date();

                  console.log(
                    `✅ Found latest /register in group: ${groupName} (${cleanGroupId})`
                  );

                  const [existing] = await this.pool.query(
                    "SELECT id FROM `groups` WHERE group_id = ? AND did = ? AND uid = ?",
                    [cleanGroupId, did, uid]
                  );

                  if (existing.length === 0) {
                    // ✅ Masukkan ke database
                    await this.pool.query(
                      "INSERT INTO `groups` (group_id, name, did, uid, sender_jid, registered_at) VALUES (?, ?, ?, ?, ?, ?)",
                      [cleanGroupId, groupName, did, uid, senderJid, timestamp]
                    );
                    console.log(`🟢 Inserted group: ${groupName}`);
                  } else {
                    console.log(`⚠️ Group already exists in DB: ${groupName}`);
                  }
                }


              } catch (groupError) {
                console.error(
                  `Error processing group ${groupId}:`,
                  groupError.message
                );
              }
            }
          } catch (sessionError) {
            console.error(
              `Error processing session ${deviceKey}:`,
              sessionError.message
            );
          }
        }
      } catch (error) {
        console.error("Error in cron job:", error.message);
      } finally {
        this.isProcessing = false;
      }
    });
  }
}

module.exports = CronGroupManager;
