const { Boom } = require("@hapi/boom");

class AutoReplyManager {
  constructor(pool) {
    this.pool = pool;
  }

  async getAutoReply(apiKey, id = null) {
    const connection = await this.pool.getConnection();
    try {
      // Validasi API key
      const [[user]] = await connection.query(
        "SELECT uid FROM users WHERE api_key = ? LIMIT 1",
        [apiKey]
      );
      if (!user) {
        throw new Boom("Invalid API key", { statusCode: 401 });
      }

      const uid = user.uid;

    // Query data auto-reply
    // Hanya ambil autoreply yang terkait dengan device yang TIDAK bertatus 'deleted'
    let query = `
      SELECT 
        devices.id AS device_id, 
        devices.device_key AS device_key, 
        autoreply.id AS autoreply_id,
        autoreply.keyword, 
        autoreply.response, 
        autoreply.status, 
        autoreply.used, 
        autoreply.is_for_personal, 
        autoreply.is_for_group, 
        autoreply.created_at, 
        autoreply.updated_at 
      FROM autoreply 
      JOIN devices ON devices.id = autoreply.device_id AND devices.status != 'deleted'
      WHERE autoreply.uid = ?
    `;
      const queryParams = [uid];

      if (id !== null) {
        query += " AND autoreply.id = ?";
        queryParams.push(id);
      }

      const [autoreplies] = await connection.query(query, queryParams);

      if (id !== null && autoreplies.length === 0) {
        throw new Boom("Auto-Reply not found", { statusCode: 404 });
      }

      if (id !== null) {
        return autoreplies[0]; // Jika ambil satu berdasarkan ID
      }

      // Hitung status dan total used jika ambil banyak
      const counts = {
        active: 0,
        inactive: 0,
        totalUsed: 0,
      };

      for (const reply of autoreplies) {
        if (reply.status === "active") counts.active++;
        else if (reply.status === "inactive") counts.inactive++;

        counts.totalUsed += reply.used || 0;
      }

      return {
        autoreplies,
        counts,
      };
    } catch (error) {
      console.error("Error retrieving autoreply:", error);
      throw error.isBoom
        ? error
        : new Boom("Database error", { statusCode: 500 });
    } finally {
      connection.release();
    }
  }

  async registerAutoReply(
    apiKey,
    id,
    keyword,
    response,
    status,
    is_for_personal,
    is_for_group,
    device
  ) {
    const connection = await this.pool.getConnection();
    try {
      // Validasi API key
      const [user] = await connection.query(
        "SELECT uid FROM users WHERE api_key = ?",
        [apiKey]
      );
      if (!user[0]) throw new Error("Invalid API key");

      // Logika untuk update atau insert
      let result;
      if (id > 0) {
        // Update data jika id > 0
        [result] = await connection.query(
          "UPDATE autoreply SET keyword = ?, response = ?, status = ?, is_for_personal = ?, is_for_group = ? WHERE id = ? AND uid = ? AND device_id = ?",
          [
            keyword,
            response,
            status,
            is_for_personal,
            is_for_group,
            id,
            user[0].uid,
            device,
          ]
        );
        if (result.affectedRows === 0) {
          throw new Error(
            "No rows updated. Check if the ID exists and belongs to the user."
          );
        }
        return {
          id: id,
          keyword: keyword,
          response: response,
          status: status,
          is_for_personal: is_for_personal,
          is_for_group: is_for_group,
          device: device,
        };
      } else {
        // Insert data jika id <= 0
        [result] = await connection.query(
          "INSERT INTO autoreply (uid, keyword, response, status, is_for_personal, is_for_group, device_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [
            user[0].uid,
            keyword,
            response,
            status,
            is_for_personal,
            is_for_group,
            device,
          ]
        );
        return {
          id: result.insertId,
          keyword: keyword,
          response: response,
          status: status,
          is_for_personal: is_for_personal,
          is_for_group: is_for_group,
          device: device,
        };
      }
    } catch (error) {
      console.error("Registration error:", error);
      throw error;
    } finally {
      connection.release();
    }
  }

  async removeAutoReply(apiKey, autoreplyId) {
    const connection = await this.pool.getConnection();
    try {
      const [row] = await connection.query(
        "SELECT uid FROM users WHERE api_key = ?",
        [apiKey]
      );

      if (!row[0]) throw new Boom("Invalid API key", { statusCode: 401 });

      const [result] = await connection.query(
        "DELETE FROM autoreply WHERE uid = ? AND id = ?",
        [row[0].uid, autoreplyId]
      );

      if (result.affectedRows === 0) {
        throw new Boom("AutoReply not found", { statusCode: 404 });
      }

      return { status: true };
    } catch (error) {
      console.error("Error removing autoreply:", error);
      throw error.isBoom
        ? error
        : new Boom("Database error", { statusCode: 500 });
    } finally {
      connection.release();
    }
  }
}

module.exports = AutoReplyManager;
