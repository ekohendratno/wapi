const mysql = require('mysql2/promise');
const crypto = require('crypto');
const { generateAPIKey, generateDeviceID } = require('../lib/Generate');

class InitData {
    constructor(pool) {
        this.pool = pool;
        this.initDatabase();
    }

    async initDatabase() {
        const connection = await this.pool.getConnection();
        try {
            console.log("🔹 Inisialisasi database...");

            // Buat tabel users jika belum ada
            await connection.query(`
                CREATE TABLE IF NOT EXISTS users (
                    uid INT AUTO_INCREMENT PRIMARY KEY,
                    name VARCHAR(60) NOT NULL,
                    email VARCHAR(80) NOT NULL UNIQUE,
                    phone VARCHAR(30) NOT NULL,
                    username VARCHAR(60) NOT NULL UNIQUE,
                    password VARCHAR(255) NOT NULL,
                    api_key VARCHAR(255) NOT NULL UNIQUE,
                    active TINYINT(1) DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);
            console.log("✅ Tabel 'users' siap digunakan.");

            // Buat tabel balances jika belum ada
            await connection.query(`
                CREATE TABLE IF NOT EXISTS balances (
                    uid INT AUTO_INCREMENT PRIMARY KEY,
                    balance DECIMAL(10,2) NOT NULL DEFAULT 0.00,
                    total_used DECIMAL(10,2) NOT NULL DEFAULT 0.00,
                    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
                );
            `);
            console.log("✅ Tabel 'balances' siap digunakan.");

            // Buat tabel devices jika belum ada
            await connection.query(`
                CREATE TABLE IF NOT EXISTS devices (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    uid INT NOT NULL,
                    name VARCHAR(255) NOT NULL,
                    phone VARCHAR(255) NOT NULL,
                    status VARCHAR(30) DEFAULT 'connecting',
                    device_key VARCHAR(255) NOT NULL UNIQUE,
                    packageId VARCHAR(30),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
                );
            `);
            console.log("✅ Tabel 'devices' siap digunakan.");

            // Buat tabel messages jika belum ada
            await connection.query(`
                CREATE TABLE IF NOT EXISTS messages (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    uid INT NOT NULL,
                    device_id INT NOT NULL,
                    number VARCHAR(30) NOT NULL,
                    message TEXT NOT NULL,
                    type VARCHAR(30) NOT NULL,
                    role VARCHAR(30),
                    status VARCHAR(30) DEFAULT 'pending',
                    response TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP NULL,
                    FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
                );
            `);
            console.log("✅ Tabel 'messages' siap digunakan.");

            // Buat tabel autoreply jika belum ada
            await connection.query(`
                CREATE TABLE IF NOT EXISTS autoreply (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    uid INT NOT NULL,
                    keyword VARCHAR(255) NOT NULL,
                    response TEXT NOT NULL,
                    status VARCHAR(30) NOT NULL DEFAULT 'active',
                    used INT DEFAULT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    is_for_personal TINYINT(1) DEFAULT 1,
                    is_for_group TINYINT(1) DEFAULT 0,
                    FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
                );
            `);
            console.log("✅ Tabel 'autoreply' siap digunakan.");

            // Buat tabel logs jika belum ada
            await connection.query(`
                CREATE TABLE IF NOT EXISTS logs (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    uid INT NOT NULL,
                    action VARCHAR(255) NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
                );
            `);
            console.log("✅ Tabel 'logs' siap digunakan.");

            // Cek apakah tabel users kosong
            const [rows] = await connection.query("SELECT COUNT(*) AS count FROM users");
            if (rows[0].count === 0) {
                const hashedPassword = crypto.randomBytes(16).toString('hex');
                await connection.query(`
                    INSERT INTO users (name, email, phone, username, password, api_key, active) VALUES
                    ('Admin', 'admin@example.com', '123456789', 'admin', ?, ?, 1);
                `, [hashedPassword, generateAPIKey()]);
                console.log("✅ Data awal berhasil dimasukkan.");
            } else {
                console.log("ℹ️ Data awal sudah ada.");
            }
        } catch (error) {
            console.error("❌ Error inisialisasi database:", error);
        } finally {
            connection.release();
        }
    }

}

module.exports = InitData;
