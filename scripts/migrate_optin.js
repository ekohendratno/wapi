const mysql = require("mysql2/promise");
require("dotenv").config();
const dbConfig = require("../config");

async function migrate() {
  const pool = mysql.createPool(dbConfig);
  try {
    console.log("🚀 Starting migration: Create opt_ins table...");

    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS opt_ins (
        id int NOT NULL AUTO_INCREMENT,
        uid int NOT NULL,
        device_id int NOT NULL,
        number varchar(50) NOT NULL,
        status enum('opt-in','opt-out') DEFAULT 'opt-in',
        source varchar(50) DEFAULT 'chat',
        created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY unique_opt_in (uid, number)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `;

    await pool.query(createTableQuery);
    console.log("✅ Table opt_ins created or already exists.");

    // Add opt_in_keywords to settings if needed, or just hardcode first.
    // For now, let's just create the table.
  } catch (error) {
    console.error("❌ Migration failed:", error);
  } finally {
    await pool.end();
  }
}

migrate();
