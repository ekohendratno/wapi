const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const router = express.Router();
const duitkuConfig = require("../config-duitku"); // Konfigurasi Duitku

module.exports = ({ sessionManager, billingManager }) => {
  /**
   * Route untuk halaman utama.
   */
  router.get("/", async (req, res) => {
    // Tambahkan async di sini
    const sessions = sessionManager.getAllSessions();
    let packages = []; // Gunakan let karena akan diubah dalam try

    try {
      packages = await billingManager.getPackages(); // Tambahkan await
    } catch (error) {
      console.error("Error fetching packages:", error);
    }

    res.render("index", {
      path: req.originalUrl,
      sessions,
      packages,
      title: "Selamat Datang di w@pi",
      layout: "layouts/main",
    });
  });

  router.get("/check-pending-transaction", async (req, res) => {
    try {
      const { merchantOrderId } = req.query;

      if (!merchantOrderId) {
        return res
          .status(400)
          .json({ success: false, message: "merchantOrderId diperlukan." });
      }

      const apiKey = req.session?.user?.api_key;
      if (!apiKey) {
        return res
          .status(401)
          .json({ success: false, message: "API key tidak ditemukan." });
      }

      const pendingTransaction = await billingManager.getPendingTransactions(apiKey, merchantOrderId);

      return res.json({
        success: true,
        hasPending: !!pendingTransaction,
        reference: pendingTransaction?.reference || null,
        paymentUrl: pendingTransaction?.paymentUrl || null,
        message: pendingTransaction ? "Transaksi pending ditemukan." : "Tidak ada transaksi pending.",
      });
    } catch (error) {
      console.error("Error checking pending transaction:", error);
      res
        .status(500)
        .json({ success: false, message: "Terjadi kesalahan pada server." });
    }
  });

  /**
   * Route untuk membuat invoice.
   */
  router.post("/create-invoice", async (req, res) => {
    try {
      // validate session and required fields
      const user = req.session && req.session.user;
      if (!user || !user.api_key) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      const api_key = user.api_key;
      const name = user.name || '';
      const email = user.email || '';
      const phone = user.phone || '';

      // Ambil konfigurasi Duitku
      const environment = duitkuConfig.environment || 'sandbox';
      const merchantCode = duitkuConfig.merchantCode;
      const merchantKey = duitkuConfig.merchantKey;

      const { paymentAmount, paymentMethod, productDetail } = req.body || {};
      const amount = Number(paymentAmount || 0);
      if (!amount || amount <= 0) return res.status(400).json({ success: false, message: 'Invalid payment amount' });
      const pm = paymentMethod || 'VA';
      const productDesc = productDetail || `Top-Up Saldo`;

      // Generate unique order id and timestamp (Duitku expects seconds)
      const merchantOrderId = Date.now().toString();
      const timestamp = Math.floor(Date.now() / 1000); // seconds

      // compute signature (keep existing format but ensure string)
      // Note: many Duitku integrations expect timestamp in seconds; using ms causes "Request Expired".
      const signature = crypto
        .createHash('sha256')
        .update(`${merchantCode}${timestamp}${merchantKey}`)
        .digest('hex');

      const requestBody = {
        paymentAmount: parseInt(amount),
        merchantOrderId: merchantOrderId,
        productDetails: productDesc,
        paymentMethod: pm,
        email: email,
        phoneNumber: phone,
        customerVaName: name,
        callbackUrl: duitkuConfig.callbackUrl,
        returnUrl: duitkuConfig.returnUrl,
        expiryPeriod: 10,
      };

      const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-duitku-signature': signature,
        'x-duitku-timestamp': String(timestamp),
        'x-duitku-merchantcode': merchantCode,
      };

      // Use helper that wraps duitku-nodejs to create invoice (handles signature/timestamp)
      const { createDuitkuInvoice } = require('../lib/DuitKu');
      let duitkuResp;
      try {
        // pass merchantOrderId so saved transaction and gateway request use same id
        duitkuResp = await createDuitkuInvoice(user, amount, pm, productDesc, merchantOrderId);
      } catch (err) {
        console.error('createDuitkuInvoice failed:', err && (err.response ? err.response.data : err.message));
        return res.status(502).json({ success: false, message: 'Failed to reach payment gateway', details: err && err.response && err.response.data ? err.response.data : err.message });
      }

      // save transaction (include paymentUrl if available)
      try {
        await billingManager.addTransaction(api_key, duitkuResp.merchantOrderId, duitkuResp.reference, productDesc, amount, 'pending', duitkuResp.paymentUrl || null);
      } catch (err) {
        console.error('Failed to save transaction:', err && err.message);
        return res.status(500).json({ success: false, message: 'Failed to save transaction' });
      }

      return res.json({ success: true, reference: duitkuResp.reference, paymentUrl: duitkuResp.paymentUrl, merchantOrderId: duitkuResp.merchantOrderId });
    } catch (error) {
      console.error(
        "Error creating invoice:",
        error.response ? error.response.data : error.message
      );
      res.status(500).json({ success: false, message: error.message });
    }
  });

  /**
   * Change payment method for a pending transaction.
   * Expects { merchantOrderId, paymentMethod }
   */
  router.post('/change-payment-method', async (req, res) => {
    try {
      const user = req.session && req.session.user;
      if (!user || !user.api_key) return res.status(401).json({ success: false, message: 'Unauthorized' });

      const { merchantOrderId, paymentMethod } = req.body || {};
      if (!merchantOrderId || !paymentMethod) return res.status(400).json({ success: false, message: 'merchantOrderId and paymentMethod required' });

      // fetch transaction for this user
      const tx = await billingManager.getTransactionByMerchantOrderId(user.api_key, merchantOrderId);
      if (!tx) return res.status(404).json({ success: false, message: 'Transaction not found' });
      if (tx.status !== 'pending') return res.status(400).json({ success: false, message: 'Only pending transactions can change payment method' });

      // recreate invoice using same merchantOrderId and amount
      const amount = parseFloat(tx.amount);
      const productDesc = tx.description || 'Top-Up Saldo';

      const { createDuitkuInvoice } = require('../lib/DuitKu');
      let duitkuResp;
      try {
        duitkuResp = await createDuitkuInvoice(user, amount, paymentMethod, productDesc, merchantOrderId);
      } catch (err) {
        console.error('change-payment-method createDuitkuInvoice failed:', err && (err.response ? err.response.data : err.message));
        return res.status(502).json({ success: false, message: 'Failed to reach payment gateway', details: err && err.response && err.response.data ? err.response.data : err.message });
      }

      try {
        await billingManager.updateTransactionInvoice(merchantOrderId, duitkuResp.reference, duitkuResp.paymentUrl || null);
      } catch (err) {
        console.error('Failed to update transaction invoice:', err && err.message);
        return res.status(500).json({ success: false, message: 'Failed to update transaction' });
      }

      return res.json({ success: true, reference: duitkuResp.reference, paymentUrl: duitkuResp.paymentUrl, merchantOrderId });
    } catch (error) {
      console.error('Error change-payment-method:', error && error.message);
      return res.status(500).json({ success: false, message: error.message });
    }
  });

  router.get("/success", async (req, res) => {
    try {
      const { resultCode, merchantOrderId, reference } = req.query;

      if (!resultCode || !merchantOrderId || !reference) {
        return res
          .status(400)
          .json({ success: false, message: "Parameter tidak lengkap." });
      }

      const status =
        resultCode === "00"
          ? "success"
          : resultCode === "01"
          ? "pending"
          : "failed";
      await billingManager.updateTransactionStatus(merchantOrderId, status);

      return res.redirect(`/client/billing`);
    } catch (error) {
      console.error("Error processing callback:", error.message);
      res.status(500).json({ success: false, message: error.message });
    }
  });

  router.post("/callback", express.json(), async (req, res) => {
    console.log("CALLBACK DITERIMA", JSON.stringify(req.body));

    try {
      const { merchantOrderId, amount, resultCode, reference } = req.body;

      if (!merchantOrderId || !amount || !resultCode) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid data from callback" });
      }

      const status =
        resultCode === "00"
          ? "success"
          : resultCode === "01"
          ? "pending"
          : "failed";

      const description = `Top-Up via Duitku (${merchantOrderId})`;

      const result = await billingManager.updateTransaction(
        merchantOrderId,
        description,
        parseFloat(amount),
        status
      );

      console.log("Update transaksi sukses:", merchantOrderId);
      return res.status(200).json({ success: true, message: result.message });
    } catch (error) {
      console.error("Callback error:", error.message);
      return res.status(500).json({ success: false, message: error.message });
    }
  });

  return router;
};
