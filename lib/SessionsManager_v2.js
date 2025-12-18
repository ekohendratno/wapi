const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');
const pino = require('pino');

const { generateGroupID } = require('./Generate');

class SessionManager {
  constructor(pool, io, deviceManager, folderSession = './.sessions') {
    this.pool = pool;
    this.io = io;
    this.deviceManager = deviceManager;
    this.folderSession = folderSession;
    this.sessions = {};
    this.shuttingDown = false;
    this._baileys = null;
    // Minimum time between QR updates (ms) to make QR stable for scanning
    this.QR_DEBOUNCE_MS = 30000; // 30 seconds

    if (!fs.existsSync(this.folderSession)) {
      fs.mkdirSync(this.folderSession, { recursive: true });
    }
  }

  async initSessions() {
    try {
      const keys = fs.readdirSync(this.folderSession).filter((f) => {
        const p = path.join(this.folderSession, f);
        try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
      });

      for (const k of keys) {
        const sessionPath = path.join(this.folderSession, k);
        try {
          await fs.promises.access(path.join(sessionPath, 'creds.json'));
          await this.createSession(k);
        } catch (err) {
          // Don't automatically remove the session folder on startup if creds.json is missing.
          // This allows administrators to restore files quickly without losing DB state.
          console.warn(`initSessions: missing or inaccessible creds.json for session ${k} (path=${sessionPath}). Skipping session creation.`);
          try {
            if (this.deviceManager && typeof this.deviceManager.updateDeviceStatus === 'function') {
              await this.deviceManager.updateDeviceStatus(k, 'error');
            }
          } catch (e) {
            console.warn(`initSessions: failed to mark device ${k} as error:`, e && e.message);
          }
        }
      }
    } catch (err) {
      console.warn('initSessions error:', err && err.message);
    }
  }

  async createSession(key) {
    const sessionPath = path.join(this.folderSession, key);
    if (!fs.existsSync(this.folderSession)) fs.mkdirSync(this.folderSession, { recursive: true });
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

  if (!this.sessions[key]) this.sessions[key] = { socket: null, qr: null, connected: false, reconnecting: false, lastQRUpdate: 0, error: null, lastError: null };
  const session = this.sessions[key];
  // reset any previous transient error when attempting to create
  session.error = null; session.lastError = null;

    // Ensure Baileys is imported dynamically (ESM) and cache exports on this._baileys
    let makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion;
    try {
      if (!this._baileys) {
        this._baileys = await import('@whiskeysockets/baileys');
      }
      makeWASocket = this._baileys.default;
      useMultiFileAuthState = this._baileys.useMultiFileAuthState;
      DisconnectReason = this._baileys.DisconnectReason;
      fetchLatestBaileysVersion = this._baileys.fetchLatestBaileysVersion;
    } catch (impErr) {
      console.error('Failed to import @whiskeysockets/baileys dynamically:', impErr && (impErr.message || impErr));
      throw impErr;
    }

    try {
      if (session.socket) {
        if (session.socket.ws && typeof session.socket.ws.close === 'function') session.socket.ws.close();
        else if (typeof session.socket.close === 'function') await session.socket.close();
      }
    } catch (e) {}

    try {
      const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
      const { version } = await fetchLatestBaileysVersion();
      // Enable logging by setting level to 'info' or 'debug'
      const socket = makeWASocket({ version, auth: state, printQRInTerminal: false, logger: pino({ level: 'info' }), getMessage: async () => ({}) });

      session.socket = socket;
      socket.ev.on('creds.update', saveCreds);

      socket.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) {
          const now = Date.now(); if (now - (session.lastQRUpdate || 0) < this.QR_DEBOUNCE_MS) return; session.lastQRUpdate = now;
          try { await qrcode.toFile(path.join(sessionPath, 'qr.png'), qr); session.qr = `/asset/sessions/${key}/qr.png?t=${Date.now()}`; session.error = null; session.lastError = null; this.io.emit('qr-update', { key, qr: session.qr }); } catch (e) { /* ignore */ }
        }

        if (connection === 'open') {
          session.connected = true; session.qr = null; session.error = null; session.lastError = null; this.io.emit('connection-status', { key, connected: true });
          // update DB status to connected (best-effort)
          try {
            if (this.deviceManager && typeof this.deviceManager.updateDeviceStatus === 'function' && socket.user) {
              const userJid = socket.user.id || '';
              const phoneText = userJid.split('@')[0] || '';
              const phoneNumber = phoneText.split(':')[0] || null;
              const pushName = socket.user.name || null;
              await this.deviceManager.updateDeviceStatus(key, 'connected', phoneNumber, pushName);
            }
          } catch (e) {
            console.warn(`Failed to persist connected status for ${key}:`, e && e.message);
          }

          // Cache device_id for this session to scope autoreply lookups
          try {
            const [drows] = await this.pool.query('SELECT id FROM devices WHERE device_key = ? LIMIT 1', [key]);
            session.deviceId = drows.length ? drows[0].id : null;
          } catch (e) {
            session.deviceId = null;
            console.warn(`Failed to resolve device id for ${key}:`, e && e.message);
          }

          socket.ev.on('messages.upsert', async ({ messages, type }) => {
            if (this.shuttingDown) return; if (type !== 'notify' || !messages || messages.length === 0) return;
            for (const msg of messages) {
              if (this.shuttingDown) break;
              const remoteJid = msg.key?.remoteJid || '';
              const messageContent = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '';
              if (typeof messageContent !== 'string' || messageContent.trim() === '') continue;
              const lowerMessage = messageContent.trim().toLowerCase();

              try {
                if (remoteJid.endsWith('@g.us') && lowerMessage === '/register') {
                  const groupMetadata = await session.socket.groupFetchAllParticipating();
                  const groups = Object.values(groupMetadata).map(g => ({ id: g.id, name: g.subject }));
                  const matched = groups.find(g => g.id === remoteJid);
                  const groupName = matched?.name || 'Unknown Group';
                  const [existing] = await this.pool.query('SELECT id FROM `groups` WHERE group_id = ? AND device_key = ?', [remoteJid, key]);
                  if (existing.length === 0) {
                    const group_key = generateGroupID();
                    await this.pool.query('INSERT INTO `groups` (group_id, group_key, name, device_key, registered_at) VALUES (?, ?, ?, ?, ?)', [remoteJid, group_key, groupName, key, new Date()]);
                    await session.socket.sendMessage(remoteJid, { text: `Grup/Channel berhasil terdaftar: *${group_key}*` });
                  } else {
                    await session.socket.sendMessage(remoteJid, { text: `Grup/Channel sudah terdaftar` });
                  }
                  continue;
                }

                if (remoteJid.endsWith('@g.us') && lowerMessage === '/unregister') {
                  const [existing] = await this.pool.query('SELECT id FROM `groups` WHERE group_id = ? AND device_key = ?', [remoteJid, key]);
                  if (existing.length > 0) {
                    await this.pool.query('DELETE FROM `groups` WHERE group_id = ? AND device_key = ?', [remoteJid, key]);
                    await session.socket.sendMessage(remoteJid, { text: `Grup/Channel telah berhasil *diunregister*.` });
                  } else {
                    await session.socket.sendMessage(remoteJid, { text: `Grup/Channel ini belum terdaftar.` });
                  }
                  continue;
                }

                // Scope autoreply to this device only. Prefer cached deviceId if available.
                let rows = [];
                try {
                  if (session.deviceId) {
                    const resp = await this.pool.query('SELECT response FROM autoreply WHERE keyword = ? AND device_id = ? AND status = ? LIMIT 1', [lowerMessage, session.deviceId, 'active']);
                    rows = resp[0];
                  } else {
                    const resp = await this.pool.query('SELECT response FROM autoreply WHERE keyword = ? AND device_id = (SELECT id FROM devices WHERE device_key = ? LIMIT 1) AND status = ? LIMIT 1', [lowerMessage, key, 'active']);
                    rows = resp[0];
                  }
                } catch (e) {
                  console.error('autoreply lookup error:', e && e.message);
                }

                if (rows && rows.length > 0) {
                  await session.socket.sendMessage(remoteJid, { text: rows[0].response });
                }
              } catch (err) {
                console.error('message handler error:', err && err.message);
              }
            }
          });
        }

        if (connection === 'close') {
          session.connected = false; this.io.emit('connection-status', { key, connected: false });
          if (lastDisconnect?.error) {
            const error = lastDisconnect.error; const isLoggedOut = error.output?.statusCode === DisconnectReason.loggedOut;
            if (isLoggedOut) {
              // Mark session as error instead of removing it immediately.
              // This allows API to report "Device logged out" or similar instead of 500.
              session.error = true; 
              session.lastError = 'Device logged out by WhatsApp (loggedOut)';
              console.warn(`Device ${key} logged out. Session marked as error.`);
              
              // Only cleanup the socket, do NOT remove the session object from memory or disk automatically
              try {
                  if (session.socket) {
                      if (session.socket.ws && typeof session.socket.ws.close === 'function') session.socket.ws.close(); 
                      else if (typeof session.socket.close === 'function') await session.socket.close(); 
                  }
              } catch(e) {}
              session.socket = null;

            } else if (!session.reconnecting) {
              session.reconnecting = true; setTimeout(() => { this.createSession(key).finally(() => { session.reconnecting = false; }); }, 5000);
            }
          }
        }
      });

      socket.ev.on('ws.connection', (update) => { if (update.error) console.error(`WS Error (${key}):`, update.error && update.error.message); });

    } catch (error) {
      console.error(`Session Error (${key}):`, error && (error.stack || error));
      // Don't remove session folder automatically on error; mark device as 'error' so admin can inspect/restore
      try {
        if (this.deviceManager && typeof this.deviceManager.updateDeviceStatus === 'function') {
          await this.deviceManager.updateDeviceStatus(key, 'error');
        }
      } catch (e) {
        console.warn(`Failed to update device status for ${key}:`, e && e.message);
      }
    }
  }

  async closeAllSessions() {
    this.shuttingDown = true;
    const keys = Object.keys(this.sessions);
    // mark sessions as disconnected during application shutdown (not removed)
    await Promise.all(keys.map(k => this.removeSession(k, false, 'disconnected')));
  }

  async removeSession(key, deleteFolder = false, status = 'removed') {
    const session = this.sessions[key];
    if (!session) return;

    try {
      if (session.socket) {
        try { if (session.socket.ws && typeof session.socket.ws.close === 'function') session.socket.ws.close(); else if (typeof session.socket.close === 'function') await session.socket.close(); } catch (e) {}
      }

      delete this.sessions[key];

      if (deleteFolder) {
        const sessionPath = path.join(this.folderSession, key);
        try { await fs.promises.rm(sessionPath, { recursive: true, force: true }); } catch (e) {}
      }

      try {
        if (this.deviceManager && typeof this.deviceManager.updateDeviceStatus === 'function') {
          await this.deviceManager.updateDeviceStatus(key, status);
        }
      } catch (e) {
        console.warn(`Failed to update device status for ${key}:`, e && e.message);
      }
    } catch (err) {
      console.error(`removeSession error for ${key}:`, err && err.message);
    }
  }

  getSession(key) { return this.sessions[key]; }
  getAllSessions() { return this.sessions; }
}

module.exports = SessionManager
