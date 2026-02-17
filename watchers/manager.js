// watchers/manager.js - Priority-based watcher orchestrator
const fs = require("fs");
const path = require("path");

// Priority levels (lower = higher priority)
const PRIORITY = {
  HOOK: 0,
  POMODORO: 1,
  GIT: 2,
  BUILD: 3,
  WINDOW: 4,
  SYSTEM: 5,
  IDLE: 6,
  DEFAULT: 7,
};

class WatcherManager {
  constructor({ statusFile, config, onStatusChange, onMessage }) {
    this.statusFile = statusFile;
    this.config = config;
    this.onStatusChange = onStatusChange;
    this.onMessage = onMessage;
    this.watchers = new Map(); // name → { watcher, priority }
    this.pollTimer = null;
    this.lastHookTime = 0;
    this.currentSource = null; // which watcher currently controls status
    this._hookWatcher = null;
  }

  register(name, watcher, priority) {
    this.watchers.set(name, { watcher, priority });
  }

  start() {
    // Start all enabled watchers
    for (const [name, { watcher }] of this.watchers) {
      try {
        watcher.start();
      } catch (e) {
        console.error(`Failed to start watcher ${name}:`, e.message);
      }
    }

    // Watch status file for hook changes (P0)
    this._hookWatcher = fs.watch(this.statusFile, () => {
      this.lastHookTime = Date.now();
    });

    // Poll all watchers and resolve priority every 2 seconds
    this.pollTimer = setInterval(() => this.resolve(), 2000);
  }

  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this._hookWatcher) {
      this._hookWatcher.close();
      this._hookWatcher = null;
    }
    for (const [, { watcher }] of this.watchers) {
      try {
        watcher.stop();
      } catch (e) {
        // ignore
      }
    }
  }

  resolve() {
    // If hook wrote status in last 120 seconds, don't override
    const hookAge = Date.now() - this.lastHookTime;
    if (hookAge < 120_000) {
      this.currentSource = "HOOK";
      return; // let hook-driven status stand
    }

    // Gather states from all watchers, pick highest priority (lowest number)
    let bestPriority = PRIORITY.DEFAULT + 1;
    let bestState = null;
    let bestSource = null;

    for (const [name, { watcher, priority }] of this.watchers) {
      try {
        const state = watcher.getState();
        if (state && state.status && priority < bestPriority) {
          bestPriority = priority;
          bestState = state;
          bestSource = name;
        }
      } catch (e) {
        // skip broken watcher
      }
    }

    if (bestState) {
      this.currentSource = bestSource;
      this.onStatusChange(bestState.status, bestSource);
      if (bestState.message) {
        this.onMessage({
          text: bestState.message,
          source: bestSource.toUpperCase(),
          duration: bestState.duration || 8000,
        });
      }
    }
  }

  getWatcher(name) {
    const entry = this.watchers.get(name);
    return entry ? entry.watcher : null;
  }

  isHookActive() {
    return Date.now() - this.lastHookTime < 120_000;
  }
}

module.exports = { WatcherManager, PRIORITY };
