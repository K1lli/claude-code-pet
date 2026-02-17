// watchers/build-watcher.js - Build folder monitoring via fs.watch
const fs = require("fs");

class BuildWatcher {
  constructor(config) {
    this.watchPath = (config && config.watchPath) || null;
    this._fsWatcher = null;
    this._debounceTimer = null;
    this._building = false;
    this._justFinished = false;
  }

  start() {
    if (!this.watchPath) return;
    this._startWatching();
  }

  stop() {
    this._stopWatching();
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
  }

  setWatchPath(watchPath) {
    this.stop();
    this.watchPath = watchPath;
    this._building = false;
    this._justFinished = false;
    if (watchPath) this.start();
  }

  _startWatching() {
    if (!this.watchPath) return;
    try {
      this._fsWatcher = fs.watch(this.watchPath, { recursive: true }, () => {
        this._building = true;
        this._justFinished = false;

        // Reset debounce timer - 3 seconds of quiet means build is done
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => {
          this._building = false;
          this._justFinished = true;
          // Clear "just finished" after 8 seconds
          setTimeout(() => {
            this._justFinished = false;
          }, 8000);
        }, 3000);
      });
    } catch (e) {
      // Path might not exist
    }
  }

  _stopWatching() {
    if (this._fsWatcher) {
      this._fsWatcher.close();
      this._fsWatcher = null;
    }
  }

  getState() {
    if (this._building) {
      return { status: "cooking", message: "Build in progress..." };
    }
    if (this._justFinished) {
      return { status: "success", message: "Build complete!" };
    }
    return null;
  }
}

module.exports = { BuildWatcher };
