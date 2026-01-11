const mysql = require("mysql2/promise");
require("dotenv").config();
const dbConfig = require("../config");

async function migrate() {
  const pool = mysql.createPool(dbConfig);
  try {
    console.log("🚀 Creating contacts table for LID resolution...");

    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS contacts (
        id int NOT NULL AUTO_INCREMENT,
        uid int NOT NULL,
        device_id int NOT NULL,
        jid varchar(100) NOT NULL,
        phone varchar(100) DEFAULT NULL,
        name varchar(255) DEFAULT NULL,
        updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY unique_jid (uid, device_id, jid)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
    `;

    await pool.query(createTableQuery);
    console.log("✅ Table contacts created.");
  } catch (error) {
    console.error("❌ Migration failed:", error);
  } finally {
    await pool.end();
  }
}

migrate();
