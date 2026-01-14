module.exports = {
  apps: [
    {
      name: "wapi",
      script: "./index.js",
      cwd: "c:\\Users\\DAVA\\Documents\\Node\\wa01mysql", // path kerja project
      watch: false,
      autorestart: true,
      max_memory_restart: "1024M",
      env: {
        NODE_ENV: "production",
        NODE_OPTIONS: "--max-old-space-size=1024",
      },
    },
  ],
};
