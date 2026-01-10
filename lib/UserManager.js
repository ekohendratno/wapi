const moment = require("moment-timezone");
const { Boom } = require("@hapi/boom");
const { generateAPIKey, generateDeviceID } = require("../lib/Generate");

class UserManager {
  constructor(pool) {
    this.pool = pool;
  }

  async registerUser(name, email, phone, ref, password) {
    const connection = await this.pool.getConnection();
    try {
      const apiKey = generateAPIKey();
      const [result] = await connection.query(
        "INSERT INTO users (name, email, phone, password, api_key) VALUES (?,?,?,?)",
        [name, email, phone, password, apiKey]
      );

      return {
        uid: result.insertId,
        api_key: apiKey,
      };
    } catch (error) {
      console.error("Registration error:", error);
      throw error;
    } finally {
      connection.release();
    }
  }

  async loginUser(username, password) {
    const connection = await this.pool.getConnection();

    try {
      // Cek ke tabel users terlebih dahulu
      const [users] = await connection.query(
        "SELECT uid, name, email, phone, api_key FROM users WHERE email = ? AND password = ? LIMIT 1",
        [username, password]
      );

      if (users.length > 0) {
        // Update last_active
        await connection.query(
          "UPDATE users SET last_active = NOW() WHERE uid = ?",
          [users[0].uid]
        );

        return {
          ...users[0],
          role: "client",
        };
      }

      // Jika tidak ditemukan di users, cek ke tabel admin
      const [admins] = await connection.query(
        "SELECT uid, name, email, phone FROM admin WHERE email = ? AND password = ? LIMIT 1",
        [username, password]
      );

      if (admins.length > 0) {
        // Tambahkan api_key = null agar konsisten
        return {
          ...admins[0],
          role: "admin",
        };
      }

      // Jika tidak ditemukan di kedua tabel
      throw new Boom("Username atau password salah", { statusCode: 401 });
    } catch (error) {
      console.error("Login error:", error);
      throw error.isBoom ? error : new Boom("Login gagal", { statusCode: 500 });
    } finally {
      connection.release();
    }
  }
}

module.exports = UserManager;
