const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../../lib/Utils.js');

module.exports = (sessionManager) => {

    router.get("/", authMiddleware, (req, res) => {
        res.render("client/bantuin", { title: "Bantuin - w@pi", layout: "layouts/client" });
    });

    return router;
};