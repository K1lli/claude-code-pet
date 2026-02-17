// watchers/system-monitor.js - CPU/RAM monitoring via os module
const os = require("os");

class SystemMonitor {
  constructor(config) {
    this.cpuHighThreshold = (config && config.cpuHighThreshold) || 80;
    this.pollInterval = null;
    this._cpuPercent = 0;
    this._ramPercent = 0;
    this._prevCpuTimes = null;
    this._highCpu = false;
  }

  start() {
    this._prevCpuTimes = this._getCpuTimes();
    this.pollInterval = setInterval(() => this._measure(), 10000);
    // Initial measure after 2s
    setTimeout(() => this._measure(), 2000);
  }

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  _getCpuTimes() {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;
    for (const cpu of cpus) {
      for (const type of Object.keys(cpu.times)) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    }
    return { idle: totalIdle, total: totalTick };
  }

  _measure() {
    // CPU
    const current = this._getCpuTimes();
    if (this._prevCpuTimes) {
      const idleDiff = current.idle - this._prevCpuTimes.idle;
      const totalDiff = current.total - this._prevCpuTimes.total;
      if (totalDiff > 0) {
        this._cpuPercent = Math.round(((totalDiff - idleDiff) / totalDiff) * 100);
      }
    }
    this._prevCpuTimes = current;
    this._highCpu = this._cpuPercent >= this.cpuHighThreshold;

    // RAM
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    this._ramPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);
  }

  getState() {
    if (this._highCpu) {
      return { status: "debugging" };
    }
    return null;
  }

  getCpuPercent() {
    return this._cpuPercent;
  }

  getRamPercent() {
    return this._ramPercent;
  }
}

module.exports = { SystemMonitor };
