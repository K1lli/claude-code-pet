// watchers/pomodoro.js - Pomodoro timer
const { Notification } = require("electron");

const PHASE = { IDLE: "idle", WORK: "work", BREAK: "break" };

class PomodoroTimer {
  constructor(config) {
    this.workMinutes = (config && config.workMinutes) || 25;
    this.breakMinutes = (config && config.breakMinutes) || 5;
    this.phase = PHASE.IDLE;
    this.remainingSec = 0;
    this.tickInterval = null;
    this._justFinished = null; // "work" or "break" when a phase just completed
  }

  start() {
    // Does nothing until startWork() is called
  }

  stop() {
    this.reset();
  }

  startWork() {
    this.phase = PHASE.WORK;
    this.remainingSec = this.workMinutes * 60;
    this._justFinished = null;
    this._startTicking();
  }

  startBreak() {
    this.phase = PHASE.BREAK;
    this.remainingSec = this.breakMinutes * 60;
    this._justFinished = null;
    this._startTicking();
  }

  reset() {
    this.phase = PHASE.IDLE;
    this.remainingSec = 0;
    this._justFinished = null;
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  toggle() {
    if (this.phase === PHASE.IDLE) {
      this.startWork();
    } else {
      this.reset();
    }
  }

  _startTicking() {
    if (this.tickInterval) clearInterval(this.tickInterval);
    this.tickInterval = setInterval(() => {
      if (this.remainingSec > 0) {
        this.remainingSec--;
      } else {
        // Phase complete
        if (this.phase === PHASE.WORK) {
          this._justFinished = "work";
          try {
            new Notification({
              title: "Pomodoro",
              body: "Work session complete! Time for a break.",
            }).show();
          } catch (e) {}
          this.startBreak();
        } else if (this.phase === PHASE.BREAK) {
          this._justFinished = "break";
          try {
            new Notification({
              title: "Pomodoro",
              body: "Break is over! Ready to work?",
            }).show();
          } catch (e) {}
          this.reset();
        }
      }
    }, 1000);
  }

  formatTime() {
    const m = Math.floor(this.remainingSec / 60);
    const s = this.remainingSec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  getState() {
    if (this.phase === PHASE.WORK) {
      return {
        status: "coding",
        message: `Work: ${this.formatTime()}`,
        duration: 3000,
      };
    }
    if (this.phase === PHASE.BREAK) {
      return {
        status: "idle-coffee",
        message: `Break: ${this.formatTime()}`,
        duration: 3000,
      };
    }
    if (this._justFinished === "work") {
      this._justFinished = null;
      return { status: "success", message: "Work session complete!" };
    }
    return null;
  }

  getPhase() {
    return this.phase;
  }

  isActive() {
    return this.phase !== PHASE.IDLE;
  }
}

module.exports = { PomodoroTimer, PHASE };
