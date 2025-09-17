// config/index.js

// Hanya untuk debugging di development
if (process.env.NODE_ENV !== "production") {
  console.log("🔌 Connecting to MySQL with:");
  console.log("Host:", process.env.DB_HOST);
  console.log("User:", process.env.DB_USER);
  console.log("Port:", process.env.DB_PORT);
  console.log("Database:", process.env.DB_NAME);
}

module.exports = {
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "wapi",
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT) || 10,
  queueLimit: parseInt(process.env.DB_QUEUE_LIMIT) || 0,
  timezone: process.env.TZ || "+07:00", // Asia/Jakarta, BUKAN 'Z'
};