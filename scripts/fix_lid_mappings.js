const mysql = require("mysql2/promise");
require("dotenv").config();
const dbConfig = require("../config");

async function fix() {
  const pool = mysql.createPool(dbConfig);
  try {
    console.log("🔍 Patching specific LID for user...");

    // Find the PN number we have in contacts
    const [pnRows] = await pool.query(
      "SELECT phone FROM contacts WHERE phone IS NOT NULL AND jid LIKE '%@s.whatsapp.net' LIMIT 1"
    );
    if (pnRows.length === 0) {
      console.log(
        "❌ Tidak ada nomor HP (PN) yang ditemukan di tabel contacts."
      );
      return;
    }
    const phone = pnRows[0].phone;

    // Update all LIDs to use this phone if they are NULL
    const [cResult] = await pool.query(
      "UPDATE contacts SET phone = ? WHERE jid LIKE '%@lid' AND phone IS NULL",
      [phone]
    );
    console.log(
      `✅ Updated ${cResult.affectedRows} LID contacts with phone ${phone}`
    );

    // Update opt_ins
    const [oResult] = await pool.query(`
        UPDATE opt_ins o
        JOIN contacts c ON (o.number = c.jid OR CONCAT(o.number, '@lid') = c.jid)
        SET o.number = c.phone
        WHERE c.phone IS NOT NULL AND CHAR_LENGTH(o.number) > 13
    `);
    console.log(`✅ Updated ${oResult.affectedRows} opt_ins records.`);
  } catch (error) {
    console.error("❌ Error:", error);
  } finally {
    await pool.end();
  }
}

fix();
