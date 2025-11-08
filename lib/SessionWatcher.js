const chokidar = require('chokidar');
const path = require('path');

class SessionWatcher {
  constructor(sessionManager, folderSession) {
    this.sessionManager = sessionManager;
    this.folderSession = folderSession;
    this.watcher = null;
  }

  init() {
    if (this.watcher) return;

    this.watcher = chokidar.watch(this.folderSession, {
      ignoreInitial: true,
      depth: 1,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    });

    // debounce / delay handling so quick restores don't cause permanent removal
    this.watcher.on('unlinkDir', (dirPath) => {
      const key = path.basename(dirPath);
      console.log(`[SessionWatcher] Detected removed session folder: ${key} (will verify in 2s)`);

      setTimeout(async () => {
        try {
          // if folder reappeared in the meantime, ignore
          if (fs.existsSync(dirPath)) {
            console.log(`[SessionWatcher] Folder ${key} was restored; ignoring removal.`);
            return;
          }

          const session = this.sessionManager.getSession(key);
          if (session) {
            // If session exists in memory, likely the socket is still active — close it and update DB
            console.log(`[SessionWatcher] In-memory session found for ${key}, removing session object.`);
            await this.sessionManager.removeSession(key, false);
            return;
          }

          // No in-memory session; update DB to 'removed' (best-effort)
          if (
            this.sessionManager.deviceManager &&
            typeof this.session_manager.deviceManager.updateDeviceStatus === 'function'
          ) {
            try {
              await this.sessionManager.deviceManager.updateDeviceStatus(key, 'removed');
              console.log(`[SessionWatcher] Device ${key} marked as removed in DB.`);
            } catch (err) {
              console.warn(`[SessionWatcher] Failed to update device status for ${key}:`, err && err.message);
            }
          }
        } catch (err) {
          console.error('[SessionWatcher] error handling unlinkDir:', err && err.message);
        }
      }, 2000);
    });

    this.watcher.on('addDir', (dirPath) => {
      const key = path.basename(dirPath);
      console.log(`[SessionWatcher] Detected new session folder: ${key}`);
      // Optionally, we could auto-create session here, but leave it passive for now.
    });

    console.log('[SessionWatcher] watching', this.folderSession);
  }

  async stop() {
    if (this.watcher) {
      try {
        await this.watcher.close();
      } catch (err) {
        console.warn('[SessionWatcher] stop error:', err && err.message);
      }
      this.watcher = null;
    }
  }
}

module.exports = SessionWatcher;
