process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

process.on("uncaughtExceptionMonitor", (error) => {
  console.error("[Critical Error]", error);
});

const path = require("path");
const { Boom } = require("@hapi/boom");
// Note: @whiskeysockets/baileys is ESM-only in modern versions.
// We dynamically import it inside the session manager to avoid
// ERR_REQUIRE_ESM when running under CommonJS.
const pino = require("pino");
const express = require("express");
// body-parser deprecated: prefer built-in express middleware
const qrcode = require("qrcode");
const http = require("http");
const socketIO = require("socket.io");
const fs = require("fs");
const cors = require("cors");
const mysql = require("mysql2/promise");

require("dotenv").config();

const dbConfig = require("./config");
const pool = mysql.createPool(dbConfig);

const InitData = require("./lib/InitData.js");
const SessionManager = require("./lib/SessionsManager_v2.js");
const BillingManager = require("./lib/BillingManager");
const CronManager = require("./lib/CronManager.js");
const CronGroupManager = require("./lib/CronGroupManager.js");
const MessageManager = require("./lib/MessageManager.js");
const DeviceManager = require("./lib/DeviceManager.js");
const AutoReplyManager = require("./lib/AutoReplyManager.js");
const UserManager = require("./lib/UserManager.js");
const { requireRole, redirectIfLoggedIn } = require("./lib/Utils.js");

const expressLayouts = require("express-ejs-layouts");

// Setup server dan IO
const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*", // Atau domain spesifik: "https://yourdomain.com"
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"], // Fallback jika websocket gagal
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(expressLayouts);
app.use(express.static(path.join(__dirname, "public")));
app.set("view engine", "ejs");
app.set("views", __dirname + "/views");
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type"],
    credentials: true,
  })
);

const session = require("express-session");
const MySQLStore = require("express-mysql-session")(session);
const sessionStore = new MySQLStore({}, pool); // pool is already created using mysql2/promise

app.set("trust proxy", 1); // Aktifkan jika pakai Nginx/Cloudflare

app.use(
  session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || "fallback-secret-for-dev-only-123",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure:
        process.env.NODE_ENV === "production" &&
        (process.env.SERVER_URL?.startsWith("https") ||
          process.env.FORCE_SECURE_COOKIE === "true"),
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 jam
      sameSite: "lax",
    },
    rolling: true,
    name: "wapi.sid", // Opsional: ganti nama cookie
  })
);

const moment = require("moment");
const momentTimezone = require("moment-timezone");
app.use((req, res, next) => {
  res.locals.moment = moment;
  res.locals.momentTimezone = momentTimezone;
  next();
});

const folderSession = "./.sessions";
app.use("/asset/sessions", express.static(folderSession));

const morgan = require("morgan");
// Logging HTTP requests
if (process.env.NODE_ENV !== "production") {
  app.use(morgan("dev"));
} else {
  app.use(morgan("combined"));
}

// Inisialisasi manager
const initData = new InitData(pool);

const deviceManager = new DeviceManager(pool);
const sessionManager = new SessionManager(
  pool,
  io,
  deviceManager,
  folderSession
);
const billingManager = new BillingManager(pool);
const messageManager = new MessageManager(pool, sessionManager);
const userManager = new UserManager(pool);
const autoreplyManager = new AutoReplyManager(pool);
const cronManager = new CronManager(
  pool,
  messageManager,
  sessionManager,
  billingManager
);
const cronGroupManager = new CronGroupManager(pool, sessionManager);
const SessionWatcher = require("./lib/SessionWatcher");
const sessionWatcher = new SessionWatcher(sessionManager, folderSession);

// Routes Admin
const indexAdminRoutes = require("./routes/admin/indexRoutes.js")({
  pool,
  billingManager,
  deviceManager,
  messageManager,
  sessionManager,
  userManager,
});
const packageAdminRoutes = require("./routes/admin/packageRoutes.js")(
  billingManager,
  pool
);
const billingAdminRoutes = require("./routes/admin/billingRoutes.js")(
  billingManager
);
app.use("/admin", requireRole("admin"), indexAdminRoutes);
app.use("/admin/package", requireRole("admin"), packageAdminRoutes);
app.use("/admin/billing", requireRole("admin"), billingAdminRoutes);

// Routes Client
const indexClientRoutes = require("./routes/client/indexRoutes")({
  sessionManager,
  deviceManager,
  messageManager,
  billingManager,
});
const packageClientRoutes = require("./routes/client/packageRoutes")(
  billingManager
);
const billingClientRoutes = require("./routes/client/billingRoutes")(
  billingManager
);
const deviceClientRoutes = require("./routes/client/deviceRoutes")({
  sessionManager,
  deviceManager,
  billingManager,
});
const groupClientRoutes = require("./routes/client/groupRoutes")({
  sessionManager,
  deviceManager,
  billingManager,
});
const messageClientRoutes = require("./routes/client/messageRoutes")({
  sessionManager,
  messageManager,
  deviceManager,
});
const autoreplyClientRoutes = require("./routes/client/autoreplyRoutes")({
  sessionManager,
  autoreplyManager,
  deviceManager,
});
const bantuinClientRoutes = require("./routes/client/bantuinRoutes")(
  sessionManager
);
const dokumentasiClientRoutes = require("./routes/client/dokumentasiRoutes")(
  sessionManager
);

app.use("/client", requireRole("client"), indexClientRoutes);
app.use("/client/package", requireRole("client"), packageClientRoutes);
app.use("/client/billing", requireRole("client"), billingClientRoutes);
app.use("/client/device", requireRole("client"), deviceClientRoutes);
app.use("/client/group", requireRole("client"), groupClientRoutes);
app.use("/client/message", requireRole("client"), messageClientRoutes);
app.use("/client/autoreply", requireRole("client"), autoreplyClientRoutes);
app.use("/client/bantuin", requireRole("client"), bantuinClientRoutes);
app.use("/client/dokumentasi", requireRole("client"), dokumentasiClientRoutes);

// Routes Main
const indexRoutes = require("./routes/indexRoutes")({
  sessionManager,
  billingManager,
});
const v1Routes = require("./routes/v1Routes")({
  sessionManager,
  messageManager,
});
const authRoutes = require("./routes/authRoutes")({
  sessionManager,
  userManager,
});
const sessionRoutes = require("./routes/sessionRoutes")(sessionManager);
const messageRoutes = require("./routes/messageRoutes")({
  sessionManager,
  messageManager,
});
const groupRoutes = require("./routes/groupRoutes")(sessionManager);

app.use("/", indexRoutes);
app.use("/v1", v1Routes);
app.use("/bot", v1Routes); //backup lama
app.use("/auth", authRoutes);
app.use("/session", sessionRoutes);
app.use("/message", messageRoutes);
app.use("/group", groupRoutes);
// Health check endpoint
app.get("/health", async (req, res) => {
  try {
    // Cek koneksi database
    await pool.query("SELECT 1");

    // Cek minimal 1 session aktif
    const sessions = sessionManager.getAllSessions();
    const activeSessions = Object.values(sessions).filter(
      (s) => s.connected
    ).length;

    res.json({
      status: "OK",
      timestamp: new Date().toISOString(),
      database: "connected",
      active_sessions: activeSessions,
      uptime: process.uptime(),
    });
  } catch (err) {
    console.error("Health check failed:", err.message);
    res.status(503).json({ status: "ERROR", error: err.message });
  }
});

// Global error handler (Express)
app.use((err, req, res, next) => {
  console.error("Express Error:", err.stack);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    error: "Internal Server Error",
    message:
      process.env.NODE_ENV === "production"
        ? "Terjadi kesalahan pada server"
        : err.message,
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: "Not Found",
    message: "Endpoint tidak ditemukan",
  });
});

// Menjadi:
// Start Server Function
const startServer = async () => {
  try {
    // 1. Initialize Database
    console.log("🔄 Initializing Database...");
    await initData.initDatabase();
    console.log("✅ Database initialized.");

    // 2. Initialize Sessions (Parallel loading happens inside)
    console.log("🔄 Initializing Sessions...");
    await sessionManager.initSessions();
    console.log("✅ Sessions initialized.");

    // 3. Initialize Crons
    console.log("🔄 Initializing Crons...");
    cronManager.initCrons();
    console.log("✅ Crons initialized.");

    // 4. Start Session Watcher
    try {
      sessionWatcher.init();
    } catch (err) {
      console.warn("SessionWatcher init failed:", err.message);
    }

    // 5. Start Server
    const PORT = process.env.SERVER_PORT || 3000;
    const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;

    server.listen(PORT, () => {
      console.log(`🚀 WhatsApp Gateway running on ${SERVER_URL}`);
      console.log(`📊 Environment: ${process.env.NODE_ENV}`);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
};

startServer();

// Graceful shutdown
let isShuttingDown = false;
const shutdown = async (signal) => {
  if (isShuttingDown) {
    console.log(`Already shutting down, ignoring ${signal}`);
    return;
  }
  isShuttingDown = true;

  console.log(`\n${signal} received. Shutting down gracefully...`);

  try {
    // Hentikan cron
    console.log("🛑 Stopping cron jobs...");
    if (cronManager && typeof cronManager.stop === "function") {
      await cronManager.stop();
    }

    // Stop session watcher
    if (sessionWatcher && typeof sessionWatcher.stop === "function") {
      await sessionWatcher.stop();
      console.log("Session watcher stopped.");
    }

    // Tutup semua session
    console.log("🔌 Closing all WhatsApp sessions...");
    if (
      sessionManager &&
      typeof sessionManager.closeAllSessions === "function"
    ) {
      await sessionManager.closeAllSessions();
    } else {
      const sessions = sessionManager.getAllSessions();
      for (const key in sessions) {
        try {
          await sessionManager.removeSession(key, false);
        } catch (err) {
          console.warn(`Failed to close session ${key}:`, err.message);
        }
      }
    }

    // Tutup koneksi database
    console.log("💾 Closing database pool...");
    try {
      await pool.end();
    } catch (err) {
      console.warn("Error while closing DB pool:", err && err.message);
    }

    // Tutup server
    server.close(() => {
      console.log("✅ Server closed gracefully.");
      process.exit(0);
    });

    // Force exit setelah 10 detik
    setTimeout(() => {
      console.error("❌ Could not close gracefully. Forcing exit.");
      process.exit(1);
    }, 10000);
  } catch (err) {
    console.error("Shutdown error:", err && err.message);
    process.exit(1);
  }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
