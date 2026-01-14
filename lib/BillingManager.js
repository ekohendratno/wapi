const mysql = require("mysql2/promise");

class BillingManager {
  constructor(pool) {
    this.pool = pool;
  }

  async addTransaction(
    apiKey,
    merchantOrderId,
    reference,
    description,
    amount,
    status,
    paymentUrl = null
  ) {
    const connection = await this.pool.getConnection();
    try {
      // Validasi API key
      const [users] = await connection.query(
        "SELECT uid FROM users WHERE api_key = ? LIMIT 1",
        [apiKey]
      );
      if (users.length === 0) {
        throw new Error("Invalid API key");
      }
      const userId = users[0].uid;

      // Mulai transaksi database
      await connection.beginTransaction();

      // Cek apakah transaksi dengan merchantOrderId sudah ada
      const [existingTransactions] = await connection.query(
        "SELECT id FROM transactions WHERE merchantOrderId = ? LIMIT 1",
        [merchantOrderId]
      );
      if (existingTransactions.length > 0) {
        throw new Error("Transaksi dengan Merchant Order ID ini sudah ada.");
      }

      // Cek apakah saldo pengguna sudah ada
      const [existingBalance] = await connection.query(
        "SELECT uid FROM balances WHERE uid = ? LIMIT 1",
        [userId]
      );

      // Jika saldo belum ada, insert dengan nilai default balance = 0, total_used = 0
      if (existingBalance.length === 0) {
        await connection.query(
          "INSERT INTO balances (uid, balance, total_used) VALUES (?, 0, 0)",
          [userId]
        );
        console.log(`Saldo baru ditambahkan untuk UID: ${userId}`);
      }

      // Tambahkan transaksi baru tanpa mengupdate saldo
      await connection.query(
        "INSERT INTO transactions (uid, merchantOrderId, paymentUrl, reference, description, amount, status, whatIs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          userId,
          merchantOrderId,
          paymentUrl,
          reference,
          description,
          parseFloat(amount),
          status,
          "+",
        ]
      );

      console.log(
        `Transaksi baru ditambahkan: ${merchantOrderId}, Status: ${status}`
      );

      // Commit transaksi
      await connection.commit();

      return { success: true, message: "Transaksi berhasil ditambahkan." };
    } catch (error) {
      await connection.rollback();
      console.error("Error adding transaction:", error.message);
      throw error;
    } finally {
      connection.release();
    }
  }

  async getTransactions(apiKey, status = "all") {
    const connection = await this.pool.getConnection();
    try {
      // Validasi API key
      const [users] = await connection.query(
        "SELECT uid FROM users WHERE api_key = ? LIMIT 1",
        [apiKey]
      );
      if (users.length === 0) {
        throw new Error("Invalid API key");
      }
      const userId = users[0].uid;

      // Ambil daftar transaksi
      let query = `
      SELECT merchantOrderId, reference, paymentUrl, description, amount, status, whatIs, created_at 
      FROM transactions 
      WHERE uid = ?
    `;
      if (status && status !== "all") {
        query += ` AND status = ?`;
      }
      query += ` ORDER BY created_at DESC`;
      const queryParams =
        status && status !== "all" ? [userId, status] : [userId];
      const [transactions] = await connection.query(query, queryParams);

      // Format
      const formattedTransactions = transactions.map((tx) => ({
        ...tx,
        formattedDate: new Date(tx.created_at).toLocaleDateString("id-ID", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        }),
        amountFormatted:
          parseFloat(tx.amount) >= 0
            ? `<span class="badge bg-success">+</span> Rp ${parseFloat(
                tx.amount
              ).toFixed(2)}`
            : `<span class="badge bg-warning">-</span> Rp ${Math.abs(
                parseFloat(tx.amount)
              ).toFixed(2)}`,
        // keep paymentUrl accessible to the view
        paymentUrl: tx.paymentUrl || null,
      }));

      // Ambil saldo
      const [balances] = await connection.query(
        "SELECT balance, updated_at FROM balances WHERE uid = ?",
        [userId]
      );
      const balanceInfo = balances[0] || { balance: 0 };

      // Total digunakan
      const [[transaksi]] = await connection.query(
        `
        SELECT SUM(amount) AS totalUsed 
        FROM transactions 
        WHERE whatIs = '-' 
          AND uid = ? 
          AND MONTH(created_at) = MONTH(CURRENT_DATE()) 
          AND YEAR(created_at) = YEAR(CURRENT_DATE())`,
        [userId]
      );

      // Total pending
      const [[pending]] = await connection.query(
        `
        SELECT SUM(amount) AS totalPending 
        FROM transactions 
        WHERE status = 'pending' 
          AND uid = ? 
          AND MONTH(created_at) = MONTH(CURRENT_DATE()) 
          AND YEAR(created_at) = YEAR(CURRENT_DATE())
        `,
        [userId]
      );

      return {
        transactions: formattedTransactions,
        balance: parseFloat(balanceInfo.balance) || 0,
        balanceLastUpdate: balanceInfo.updated_at || 0,
        totalUsed: Math.abs(parseFloat(transaksi?.totalUsed) || 0),
        totalPending: Math.abs(parseFloat(pending?.totalPending) || 0),
      };
    } catch (error) {
      console.error("Error retrieving transactions:", error.message);
      throw error;
    } finally {
      connection.release();
    }
  }

  async getTransactionsAll(status = "all") {
    const connection = await this.pool.getConnection();
    try {
      // Format rupiah
      const formatRupiah = (value) => {
        return new Intl.NumberFormat("id-ID", {
          style: "currency",
          currency: "IDR",
          minimumFractionDigits: 2,
        }).format(value);
      };

      // Query transaksi
      let query = `
      SELECT merchantOrderId, reference, description, amount, status, whatIs, created_at 
      FROM transactions
    `;
      const queryParams = [];
      if (status !== "all") {
        query += ` WHERE status = ?`;
        queryParams.push(status);
      }
      query += ` ORDER BY created_at DESC`;

      const [transactions] = await connection.query(query, queryParams);

      const formattedTransactions = transactions.map((tx) => ({
        ...tx,
        formattedDate: new Date(tx.created_at).toLocaleDateString("id-ID", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        }),
        amountFormatted:
          parseFloat(tx.amount) >= 0
            ? `<span class="badge bg-success">+</span> ${formatRupiah(
                tx.amount
              )}`
            : `<span class="badge bg-warning">-</span> ${formatRupiah(
                Math.abs(tx.amount)
              )}`,
      }));

      // Ambil saldo terakhir
      const [balances] = await connection.query(
        "SELECT balance, updated_at FROM balances ORDER BY updated_at DESC LIMIT 1"
      );
      const balanceInfo = balances[0] || { balance: 0, updated_at: null };

      // Total penggunaan bulan ini
      const [[transaksi]] = await connection.query(
        `SELECT SUM(amount) AS totalUsed 
       FROM transactions 
       WHERE whatIs = '-' 
         AND MONTH(created_at) = MONTH(CURRENT_DATE()) 
         AND YEAR(created_at) = YEAR(CURRENT_DATE())`
      );

      // Total pending bulan ini
      const [[pending]] = await connection.query(
        `SELECT SUM(amount) AS totalPending 
       FROM transactions 
       WHERE status = 'pending' 
         AND MONTH(created_at) = MONTH(CURRENT_DATE()) 
         AND YEAR(created_at) = YEAR(CURRENT_DATE())`
      );

      return {
        transactions: formattedTransactions,
        balance: parseFloat(balanceInfo.balance) || 0,
        balanceLastUpdate: balanceInfo.updated_at,
        totalUsed: Math.abs(parseFloat(transaksi?.totalUsed || 0)),
        totalPending: Math.abs(parseFloat(pending?.totalPending || 0)),
      };
    } catch (error) {
      console.error("Error retrieving transactions:", error.message);
      throw error;
    } finally {
      connection.release();
    }
  }

  async updateTransactionStatus(merchantOrderId, status) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();

      // Periksa apakah transaksi dengan merchantOrderId ada
      const [existingTransactions] = await connection.query(
        "SELECT uid, amount, status FROM transactions WHERE merchantOrderId = ? LIMIT 1",
        [merchantOrderId]
      );
      if (existingTransactions.length === 0) {
        throw new Error("Transaksi tidak ditemukan");
      }

      const {
        uid: userId,
        amount,
        status: previousStatus,
      } = existingTransactions[0];
      const previousAmount = parseFloat(amount);

      // Update status transaksi
      await connection.query(
        "UPDATE transactions SET status = ? WHERE merchantOrderId = ?",
        [status, merchantOrderId]
      );

      // Jika transaksi sukses dan sebelumnya belum sukses, tambahkan saldo
      if (status === "success" && previousStatus !== "success") {
        await connection.query(
          "UPDATE balances SET balance = balance + ? WHERE uid = ?",
          [previousAmount, userId]
        );

        console.log(`Saldo diperbarui: UID ${userId}, +${previousAmount}`);
      }

      await connection.commit();
      return { success: true, message: "Transaksi berhasil diperbarui." };
    } catch (error) {
      await connection.rollback();
      console.error("Error updating transaction status:", error.message);
      throw error;
    } finally {
      connection.release();
    }
  }

  async getPendingTransactions(apiKey, merchantOrderId) {
    let connection;
    try {
      connection = await this.pool.getConnection();

      // Ambil UID berdasarkan API key
      const [user] = await connection.query(
        "SELECT uid FROM users WHERE api_key = ? LIMIT 1",
        [apiKey]
      );

      if (user.length === 0) {
        throw new Error("Invalid API key");
      }

      const userId = user[0].uid;

      // Cek transaksi pending yang dibuat dalam 1 jam terakhir
      const [transactions] = await connection.query(
        `SELECT merchantOrderId, reference, paymentUrl 
                     FROM transactions 
                     WHERE uid = ? 
                     AND merchantOrderId = ? 
                     AND status = ? 
                     AND created_at >= NOW() - INTERVAL 24 HOUR 
                     LIMIT 1`,
        [userId, merchantOrderId, "pending"]
      );

      return transactions.length > 0 ? transactions[0] : null;
    } catch (error) {
      console.log("Error retrieving pending transaction:", error);
      throw error;
    } finally {
      if (connection) connection.release();
    }
  }

  async updateTransaction(merchantOrderId, description, amount, status) {
    const connection = await this.pool.getConnection();
    try {
      console.log([description, amount, status, "+", merchantOrderId]);
      // Mulai transaksi database
      await connection.beginTransaction();

      // Periksa apakah transaksi dengan merchantOrderId ada
      const [existingTransactions] = await connection.query(
        "SELECT uid, amount, status FROM transactions WHERE merchantOrderId = ? LIMIT 1",
        [merchantOrderId]
      );
      if (existingTransactions.length === 0) {
        throw new Error("Transaksi tidak ditemukan");
      }

      const userId = existingTransactions[0].uid;
      const previousAmount = parseFloat(existingTransactions[0].amount);
      const previousStatus = existingTransactions[0].status;

      // Update transaksi
      await connection.query(
        "UPDATE transactions SET description = ?, amount = ?, status = ?, whatIs = ? WHERE merchantOrderId = ?",
        [description, amount, status, "+", merchantOrderId]
      );

      // Jika status transaksi sebelumnya bukan 'success' tetapi sekarang menjadi 'success'
      if (status === "success" && previousStatus !== "success") {
        await connection.query(
          "UPDATE balances SET balance = balance + ? WHERE uid = ?",
          [amount, userId]
        );
        console.log(
          `Saldo berhasil diperbarui untuk UID: ${userId}, +${amount}`
        );
      }

      // Commit transaksi
      await connection.commit();
      return { success: true, message: "Transaksi berhasil diperbarui." };
    } catch (error) {
      await connection.rollback();
      console.log("Error updating transaction:");
      throw error;
    } finally {
      connection.release();
    }
  }

  async updateTransactionInvoice(merchantOrderId, reference, paymentUrl) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();

      const [existing] = await connection.query(
        "SELECT id FROM transactions WHERE merchantOrderId = ? LIMIT 1",
        [merchantOrderId]
      );
      if (existing.length === 0) {
        throw new Error('Transaksi tidak ditemukan');
      }

      await connection.query(
        "UPDATE transactions SET reference = ?, paymentUrl = ?, updated_at = CURRENT_TIMESTAMP WHERE merchantOrderId = ?",
        [reference, paymentUrl, merchantOrderId]
      );

      await connection.commit();
      return { success: true };
    } catch (err) {
      await connection.rollback();
      console.error('Error updating transaction invoice:', err && err.message);
      throw err;
    } finally {
      connection.release();
    }
  }

  async getTransactionByMerchantOrderId(apiKey, merchantOrderId) {
    const connection = await this.pool.getConnection();
    try {
      // validate api key => uid
      const [users] = await connection.query(
        'SELECT uid FROM users WHERE api_key = ? LIMIT 1',
        [apiKey]
      );
      if (users.length === 0) throw new Error('Invalid API key');
      const uid = users[0].uid;

      const [rows] = await connection.query(
        'SELECT merchantOrderId, reference, paymentUrl, description, amount, status, created_at FROM transactions WHERE uid = ? AND merchantOrderId = ? LIMIT 1',
        [uid, merchantOrderId]
      );
      return rows.length ? rows[0] : null;
    } catch (err) {
      console.error('Error getTransactionByMerchantOrderId:', err && err.message);
      throw err;
    } finally {
      connection.release();
    }
  }

  async getPackages() {
    const connection = await this.pool.getConnection();
    try {
      const [packages] = await connection.query("SELECT * FROM packages WHERE active=1");
      return packages || [];
    } catch (error) {
      console.log("Error retrieving packages:");
      throw new Error("Gagal mengambil daftar paket");
    } finally {
      connection.release();
    }
  }

  async getBalanceSummary(apiKey) {
    const connection = await this.pool.getConnection();
    try {
      // Validasi API key
      const [users] = await connection.query(
        "SELECT uid FROM users WHERE api_key = ? LIMIT 1",
        [apiKey]
      );
      if (users.length === 0) {
        throw new Boom("Invalid API key", { statusCode: 401 });
      }
      const userId = users[0].uid;

      // Ambil saldo pengguna
      const [balances] = await connection.query(
        "SELECT balance, total_used FROM balances WHERE uid = ?",
        [userId]
      );
      const balanceInfo = balances[0] || { balance: 0, total_used: 0 };

      return {
        balance: parseFloat(balanceInfo.balance),
        totalUsed: parseFloat(balanceInfo.total_used),
      };
    } catch (error) {
      console.log("Error retrieving balance summary:");
      throw error.isBoom
        ? error
        : new Boom("Database error", { statusCode: 500 });
    } finally {
      connection.release();
    }
  }
}

module.exports = BillingManager;
