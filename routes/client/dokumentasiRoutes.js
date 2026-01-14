const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../../lib/Utils.js');

module.exports = (sessionManager) => {

    router.get("/", authMiddleware, (req, res) => {
        res.render("client/dokumentasi", { title: "Dokumentasi - w@pi", layout: "layouts/client" });
    });

    return router;
};