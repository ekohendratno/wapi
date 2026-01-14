const mysql = require("mysql2/promise");
require("dotenv").config();
const dbConfig = require("../config");

async function migrate() {
  const pool = mysql.createPool(dbConfig);
  try {
    console.log("🚀 Updating opt_ins table schema...");

    // Check if column agreed_at exists
    const [columns] = await pool.query(
      "SHOW COLUMNS FROM opt_ins LIKE 'agreed_at'"
    );

    if (columns.length === 0) {
      await pool.query(
        "ALTER TABLE opt_ins ADD COLUMN agreed_at timestamp NULL DEFAULT NULL AFTER source"
      );
      console.log("✅ Column agreed_at added.");
    }

    // Align collations to avoid "Illegal mix of collations"
    // We'll set opt_ins.number to match messages.number (likely utf8mb4_general_ci based on wapi.sql)
    console.log("🔄 Aligning collations...");
    await pool.query(
      "ALTER TABLE opt_ins CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci"
    );
    await pool.query(
      "ALTER TABLE opt_ins MODIFY COLUMN number varchar(50) COLLATE utf8mb4_general_ci NOT NULL"
    );

    // Modify status enum
    await pool.query(
      "UPDATE opt_ins SET status = 'pending' WHERE status = 'opt-in' OR status IS NULL"
    );
    await pool.query(
      "UPDATE opt_ins SET status = 'blocked' WHERE status = 'opt-out'"
    );

    await pool.query(
      "ALTER TABLE opt_ins MODIFY COLUMN status enum('pending', 'approved', 'blocked') DEFAULT 'pending'"
    );
    console.log("✅ Column status modified to new enum.");

    // Backfill: Find all unique numbers from messages table that are not in opt_ins
    console.log("🔄 Backfilling existing numbers as 'pending'...");

    const backfillQuery = `
      INSERT IGNORE INTO opt_ins (uid, device_id, number, status, source)
      SELECT DISTINCT uid, device_id, number, 'pending', 'history'
      FROM messages
      WHERE number REGEXP '^[0-9]+$'
      AND number NOT IN (SELECT number FROM opt_ins)
    `;

    const [result] = await pool.query(backfillQuery);
    console.log(
      `✅ Backfilled ${result.affectedRows} numbers from history as 'pending'.`
    );
  } catch (error) {
    console.error("❌ Migration failed:", error);
  } finally {
    await pool.end();
  }
}

migrate();
