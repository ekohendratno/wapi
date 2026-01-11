const mysql = require("mysql2/promise");
require("dotenv").config();
const dbConfig = require("../config");

async function migrate() {
  const pool = mysql.createPool(dbConfig);
  try {
    console.log("🚀 Repairing opt_ins table schema...");

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

    // Align collations
    await pool.query(
      "ALTER TABLE opt_ins CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci"
    );

    // Modify status enum and set defaults
    // We map 'opt-in' to 'approved' and 'opt-out' to 'blocked' if they exist from old schema
    await pool.query(
      "UPDATE opt_ins SET status = 'approved' WHERE status = 'opt-in'"
    );
    await pool.query(
      "UPDATE opt_ins SET status = 'blocked' WHERE status = 'opt-out'"
    );

    await pool.query(
      "ALTER TABLE opt_ins MODIFY COLUMN status enum('pending', 'approved', 'blocked') DEFAULT 'pending'"
    );
    console.log(
      "✅ Column status modified to new enum (pending, approved, blocked)."
    );
  } catch (error) {
    console.error("❌ Migration failed:", error);
  } finally {
    await pool.end();
  }
}

migrate();
