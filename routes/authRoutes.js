const express = require("express");
const router = express.Router();
const { redirectIfLoggedIn } = require("../lib/Utils.js");

module.exports = ({ sessionManager, userManager }) => {
  router.get("/login", redirectIfLoggedIn, (req, res) => {
    res.render("auth/login", {
      path: req.originalUrl,
      error: null,
      title: "Login - w@pi",
      layout: "layouts/main",
    });
  });

  router.post("/login", redirectIfLoggedIn, async (req, res) => {
    try {
      const { username, password } = req.body;
      const user = await userManager.loginUser(username, password);

      // Simpan data pengguna ke dalam sesi
      req.session.user = {
        uid: user.uid,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        api_key: user.api_key,
      };

      res.redirect(`/${user.role}`);
    } catch (error) {
      res.render("auth/login", {
        path: req.originalUrl,
        error: error.message || "Login gagal",
        title: "Login - w@pi",
        layout: "layouts/main",
      });
    }
  });

  router.get("/register", redirectIfLoggedIn, (req, res) => {
    res.render("auth/register", {
      path: req.originalUrl,
      error: null,
      title: "Registrasi - w@pi",
      layout: "layouts/main",
    });
  });

  router.post("/register", redirectIfLoggedIn, async (req, res) => {
    try {
      const { name, email, phone, ref, password, repassword } = req.body;

      if (!password || !repassword) {
        throw new Error("Password dan Konfirmasi Password harus diisi");
      }
      if (password.length < 6) {
        throw new Error("Password harus memiliki minimal 6 karakter");
      }
      if (password !== repassword) {
        throw new Error("Konfirmasi Password tidak cocok");
      }

      const user = await userManager.registerUser(
        name,
        email,
        phone,
        ref,
        password,
        repassword
      );

      req.session.user = user;
      res.redirect("/client");
    } catch (error) {
      res.render("auth/register", {
        error: error.message || "Registrasi gagal",
        title: "Registrasi - w@pi",
        layout: "layouts/main",
      });
    }
  });

  // Logout
  router.get("/logout", (req, res) => {
    req.session.destroy();
    res.redirect("/auth/login");
  });

  return router;
};
