const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../../lib/Utils.js");
const { generateAPIKey } = require("../../lib/Generate.js");

module.exports = ({ pool } = {}) => {
  // List Users
  router.get("/", authMiddleware, async (req, res) => {
    try {
      const [users] = await pool.query(
        "SELECT * FROM users ORDER BY created_at DESC"
      );
      res.render("admin/users", {
        title: "Users Management - w@pi",
        layout: "layouts/admin",
        users,
      });
    } catch (error) {
      console.error("Error fetching users:", error);
      res.status(500).send("Internal Server Error");
    }
  });

  // Get User for Edit
  router.get("/edit/:uid", authMiddleware, async (req, res) => {
    try {
      const [rows] = await pool.query("SELECT * FROM users WHERE uid = ?", [
        req.params.uid,
      ]);
      if (rows.length === 0)
        return res
          .status(404)
          .json({ status: false, message: "User not found" });
      // hide password
      const user = rows[0];
      delete user.password;
      res.json({ status: true, data: user });
    } catch (e) {
      console.error(e);
      res.json({ status: false, message: e.message });
    }
  });

  // Save User (Add/Edit)
  router.post("/save", authMiddleware, async (req, res) => {
    const { uid, name, email, phone, password, status } = req.body;
    // Basic validation
    if (!name || !email)
      return res.json({
        status: false,
        message: "Name and Email are required",
      });

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      if (uid && uid != 0) {
        // Update
        let query =
          "UPDATE users SET name=?, email=?, phone=?, status=? WHERE uid=?";
        let params = [name, email, phone, status || "active", uid];

        if (password && password.trim() !== "") {
          query =
            "UPDATE users SET name=?, email=?, phone=?, status=?, password=? WHERE uid=?";
          params = [name, email, phone, status || "active", password, uid];
        }
        await connection.query(query, params);
      } else {
        // Insert
        // check email exist
        const [exist] = await connection.query(
          "SELECT uid FROM users WHERE email=? LIMIT 1",
          [email]
        );
        if (exist.length > 0) throw new Error("Email already registered");

        const apiKey = generateAPIKey();
        const pass = password || "123456"; // default password if empty
        await connection.query(
          "INSERT INTO users (name, email, phone, password, api_key, status) VALUES (?, ?, ?, ?, ?, ?)",
          [name, email, phone, pass, apiKey, status || "active"]
        );
      }

      await connection.commit();
      res.json({ status: true });
    } catch (e) {
      await connection.rollback();
      console.error(e);
      res.json({ status: false, message: e.message });
    } finally {
      connection.release();
    }
  });

  // Delete User
  router.delete("/delete/:uid", authMiddleware, async (req, res) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      // delete related data (cascade usually handles this, but let's be safe or minimal)
      // For now, just delete user.
      await connection.query("DELETE FROM users WHERE uid = ?", [
        req.params.uid,
      ]);
      await connection.commit();
      res.json({ status: true });
    } catch (e) {
      await connection.rollback();
      console.error(e);
      res.json({ status: false, message: e.message });
    } finally {
      connection.release();
    }
  });

  return router;
};
