// watchers/idle-detector.js - System idle detection via Electron powerMonitor
const { powerMonitor } = require("electron");

class IdleDetector {
  constructor(config) {
    this.thresholdSec = (config && config.idleThresholdSec) || 60;
    this.pollInterval = null;
    this._idle = false;
  }

  start() {
    this.pollInterval = setInterval(() => {
      const idleTime = powerMonitor.getSystemIdleTime();
      this._idle = idleTime >= this.thresholdSec;
    }, 15000);
  }

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  getState() {
    if (this._idle) {
      return { status: "idle" };
    }
    return null;
  }
}

module.exports = { IdleDetector };
