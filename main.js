// main.js - Electron main process
const { app, BrowserWindow, Tray, Menu, screen, dialog, ipcMain, clipboard } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ── Hook Runner Mode ─────────────────────────────────────────────────────────
// When launched with --run-hook, act as the hook script and exit immediately.
// This uses Electron's bundled Node.js so users don't need Node.js installed.
const IS_HOOK_MODE = process.argv.includes("--run-hook");

// Status file that controls the pet's state
const STATUS_FILE = path.join(
  app.getPath("userData"),
  "claude-pet-status.txt"
);
const PROGRESSION_FILE = path.join(
  app.getPath("userData"),
  "progression.json"
);

// Ensure status file exists
if (!fs.existsSync(STATUS_FILE)) fs.writeFileSync(STATUS_FILE, "idle");

if (IS_HOOK_MODE) {
  // Reuse classifyTool from hook.js
  // In packaged app, hook.js lives in resources/ (extraResources), not inside the asar
  const hookModulePath = app.isPackaged
    ? path.join(process.resourcesPath, "hook.js")
    : path.join(__dirname, "hook.js");
  const { classifyTool } = require(hookModulePath);
  const hookEvent = process.argv[process.argv.indexOf("--run-hook") + 1];

  // Read stdin synchronously — Electron's async stdin doesn't work with pipes
  let input = "";
  try { input = fs.readFileSync(0, "utf-8"); } catch (e) {}

  let data = {};
  try { data = JSON.parse(input); } catch (e) {}

  let status = null;
  switch (hookEvent) {
    case "UserPromptSubmit": status = "thinking"; break;
    case "PreToolUse": status = classifyTool(data); break;
    case "PostToolUseFailure": status = "error"; break;
    case "Stop": status = "success"; break;
    case "Notification": status = "thinking"; break;
  }

  if (status) {
    try { fs.writeFileSync(STATUS_FILE, status); } catch (e) {}
  }
  app.exit(0);
}

let win, tray;
let currentStatus = "idle";
let lastChangeTime = Date.now();
let currentIdleVariant = "idle";
let currentActivityVariant = null;
let watcherManager = null;
let petConfig = null;

// ── Message Queue ────────────────────────────────────────────────────────────

const messageQueue = [];
let messageProcessing = false;
const MAX_QUEUE = 5;

// Duration based on text length: ~500ms per word, min 8s, max 18s
function calcDuration(text) {
  const words = (text || "").split(/\s+/).filter(Boolean).length;
  return Math.max(8000, Math.min(words * 500 + 6000, 18000));
}

function enqueueMessage(msg) {
  if (messageQueue.length >= MAX_QUEUE) messageQueue.shift();
  messageQueue.push(msg);
  if (!messageProcessing) processMessageQueue();
}

function processMessageQueue() {
  if (messageQueue.length === 0) {
    messageProcessing = false;
    return;
  }
  messageProcessing = true;
  const msg = messageQueue.shift();
  const duration = msg.duration || calcDuration(msg.text);
  showMessage(msg.text, msg.source, duration, msg.html);
  // Wait for the current message to finish before showing the next
  setTimeout(processMessageQueue, duration + 500);
}

function showMessage(text, source, duration, html) {
  if (!win) return;
  win.webContents.send("show-message", { text, source, duration, html });
  setTimeout(() => hideMessage(), duration);
}

function hideMessage() {
  if (!win) return;
  win.webContents.send("hide-message");
}

// ── Progression System ──────────────────────────────────────────────────────

const XP_RATES = {
  coding: 5, debugging: 5,
  thinking: 3, testing: 3, deploying: 3,
  reading: 2, searching: 2,
  installing: 1, downloading: 1, cooking: 1,
  "idle-stretching": 1, "idle-dancing": 1, "idle-butterfly": 1,
  "idle-juggling": 1, "idle-rainbow": 1, "idle-meditation": 1,
  "coding-flow": 5, "coding-hacking": 5,
  "thinking-eureka": 3, "thinking-galaxy": 3,
  "debugging-detective": 5, "debugging-rage": 5,
  "searching-treasure": 2, "searching-deep": 2,
  "reading-scholar": 2, "reading-ancient": 2,
  "testing-scientist": 3, "testing-perfectionist": 3,
  "deploying-warp": 3, "deploying-satellite": 3,
  idle: 0, success: 0, error: 0, hatching: 0, deleting: 0,
  "idle-coffee": 0,
};

const SKILL_ACTIVITIES = {
  coding: "coding", debugging: "debugging", thinking: "thinking",
  testing: "testing", deploying: "deploying", reading: "reading",
  searching: "searching", installing: "installing",
  "idle-stretching": "stretching", "idle-dancing": "dancing",
  "idle-butterfly": "wondering", "idle-juggling": "juggling",
  "idle-rainbow": "rainbow", "idle-meditation": "meditating",
  "coding-flow": "flow", "coding-hacking": "hacking",
  "thinking-eureka": "eureka", "thinking-galaxy": "galaxy brain",
  "debugging-detective": "detective", "debugging-rage": "rage",
  "searching-treasure": "treasure hunting", "searching-deep": "deep diving",
  "reading-scholar": "scholarship", "reading-ancient": "arcana",
  "testing-scientist": "science", "testing-perfectionist": "perfectionism",
  "deploying-warp": "warp", "deploying-satellite": "astronaut",
};

const TIER_NAMES = ["Hatchling", "Apprentice", "Adept", "Expert", "Master", "Legendary"];

function skillXpNeeded(level) {
  return Math.floor(100 * level * 1.2);
}

function petXpNeeded(level) {
  return Math.floor(500 * level * 1.5);
}

function getTierIndex(level) {
  if (level >= 25) return 5;
  if (level >= 20) return 4;
  if (level >= 15) return 3;
  if (level >= 10) return 2;
  if (level >= 5) return 1;
  return 0;
}

const progression = {
  data: null,
  dirty: false,
  saveTimer: null,

  load() {
    try {
      if (fs.existsSync(PROGRESSION_FILE)) {
        this.data = JSON.parse(fs.readFileSync(PROGRESSION_FILE, "utf-8"));
      }
    } catch (e) { /* corrupt — recreate */ }
    if (!this.data || this.data.version !== 1) {
      this.data = {
        version: 1,
        totalXP: 0,
        level: 1,
        skills: {
          coding:     { xp: 0, level: 1 },
          thinking:   { xp: 0, level: 1 },
          debugging:  { xp: 0, level: 1 },
          searching:  { xp: 0, level: 1 },
          reading:    { xp: 0, level: 1 },
          testing:    { xp: 0, level: 1 },
          deploying:  { xp: 0, level: 1 },
          installing: { xp: 0, level: 1 },
          stretching: { xp: 0, level: 1 },
          dancing:    { xp: 0, level: 1 },
          wondering:  { xp: 0, level: 1 },
          juggling:   { xp: 0, level: 1 },
          rainbow:    { xp: 0, level: 1 },
          meditating: { xp: 0, level: 1 },
          flow:              { xp: 0, level: 1 },
          hacking:           { xp: 0, level: 1 },
          eureka:            { xp: 0, level: 1 },
          "galaxy brain":    { xp: 0, level: 1 },
          detective:         { xp: 0, level: 1 },
          rage:              { xp: 0, level: 1 },
          "treasure hunting": { xp: 0, level: 1 },
          "deep diving":     { xp: 0, level: 1 },
          scholarship:       { xp: 0, level: 1 },
          arcana:            { xp: 0, level: 1 },
          science:           { xp: 0, level: 1 },
          perfectionism:     { xp: 0, level: 1 },
          warp:              { xp: 0, level: 1 },
          astronaut:         { xp: 0, level: 1 },
        },
        totalTimeMs: 0,
        sessions: 0,
      };
    }
    // Migrate: ensure all skill keys exist for existing saves
    const requiredSkills = [
      "coding", "thinking", "debugging", "searching", "reading",
      "testing", "deploying", "installing",
      "stretching", "dancing", "wondering", "juggling", "rainbow", "meditating",
      "flow", "hacking", "eureka", "galaxy brain", "detective", "rage",
      "treasure hunting", "deep diving", "scholarship", "arcana",
      "science", "perfectionism", "warp", "astronaut",
    ];
    for (const sk of requiredSkills) {
      if (!this.data.skills[sk]) {
        this.data.skills[sk] = { xp: 0, level: 1 };
      }
    }

    this.data.sessions++;
    this.dirty = true;
    // Debounced auto-save every 10s
    this.saveTimer = setInterval(() => {
      if (this.dirty) this.save();
    }, 10000);
  },

  save() {
    try {
      fs.writeFileSync(PROGRESSION_FILE, JSON.stringify(this.data, null, 2));
      this.dirty = false;
    } catch (e) { /* ignore */ }
  },

  tick(activity) {
    const rate = XP_RATES[activity] || 0;
    if (rate === 0) return;

    const xp = rate; // per-second tick
    this.data.totalXP += xp;
    this.data.totalTimeMs += 1000;
    this.dirty = true;

    const levelUps = [];

    // Skill XP
    const skillKey = SKILL_ACTIVITIES[activity];
    if (skillKey && this.data.skills[skillKey]) {
      const skill = this.data.skills[skillKey];
      skill.xp += xp;
      const needed = skillXpNeeded(skill.level);
      if (skill.xp >= needed) {
        skill.xp -= needed;
        skill.level++;
        levelUps.push({ type: "skill", skill: skillKey, level: skill.level });
      }
    }

    // Pet level XP — check cumulative threshold
    let cumNeeded = 0;
    for (let i = 1; i <= this.data.level; i++) cumNeeded += petXpNeeded(i);
    if (this.data.totalXP >= cumNeeded) {
      this.data.level++;
      levelUps.push({ type: "pet", level: this.data.level });
    }

    // Send level-up events
    if (levelUps.length > 0 && win) {
      for (const lu of levelUps) {
        win.webContents.send("level-up", lu);
      }
    }
  },

  getState() {
    const d = this.data;
    // Calculate XP progress toward next pet level (cumulative thresholds)
    let prevCum = 0;
    for (let i = 1; i < d.level; i++) prevCum += petXpNeeded(i);
    const currentLevelXP = d.totalXP - prevCum;
    const nextLevelXP = petXpNeeded(d.level);
    return {
      totalXP: d.totalXP,
      level: d.level,
      tierIndex: getTierIndex(d.level),
      tierName: TIER_NAMES[getTierIndex(d.level)],
      currentLevelXP: Math.max(0, currentLevelXP),
      nextLevelXP: nextLevelXP,
      skills: d.skills,
      totalTimeMs: d.totalTimeMs,
      sessions: d.sessions,
    };
  },

  shutdown() {
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.save();
  },
};

// ── Hook Setup ──────────────────────────────────────────────────────────────

function getHookPath() {
  const dest = path.join(app.getPath("userData"), "hook.js");
  // Copy the latest hook.js to userData so the path is stable after install
  try {
    fs.copyFileSync(path.join(__dirname, "hook.js"), dest);
  } catch (e) {
    // In packaged app __dirname is inside asar; file should already exist
  }
  return dest.replace(/\\/g, "/"); // forward slashes for shell commands
}

function getNodePath() {
  // Use absolute path to node so hooks work in VS Code and other environments
  // where PATH may not include Node.js
  const nodePath = process.execPath;
  // If running in Electron, process.execPath is the Electron binary, not node.
  // Fall back to finding node on PATH via 'where' (Windows) or 'which' (Unix).
  if (nodePath.toLowerCase().includes("electron") || nodePath.toLowerCase().includes("claude-code-pet")) {
    try {
      const cmd = process.platform === "win32" ? "where node" : "which node";
      const result = require("child_process").execSync(cmd, { encoding: "utf-8" }).trim();
      // 'where' on Windows can return multiple lines; take the first
      const firstLine = result.split(/\r?\n/)[0];
      return firstLine.replace(/\\/g, "/");
    } catch (e) {
      return "node"; // fallback to bare node if we can't find it
    }
  }
  return nodePath.replace(/\\/g, "/");
}

function getHookCommand() {
  if (app.isPackaged) {
    // In packaged app, use our own exe as the hook runner (no Node.js needed)
    const exePath = app.getPath("exe").replace(/\\/g, "/");
    return `"${exePath}" --run-hook`;
  }
  // In dev mode, fall back to system Node.js + hook.js (devs have Node.js)
  const hookPath = getHookPath();
  const nodePath = getNodePath();
  return `"${nodePath}" "${hookPath}"`;
}

function setupHooks() {
  const claudeDir = path.join(os.homedir(), ".claude");
  const settingsPath = path.join(claudeDir, "settings.json");

  // Read existing settings (preserve everything the user already has)
  let settings = {};
  try {
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    }
  } catch (e) {
    // corrupt file – start fresh but we'll merge back
  }

  if (!settings.hooks) settings.hooks = {};

  const MARKER = "claude-code-pet"; // our hooks contain this in the path

  // Events we hook into and whether they support a matcher
  const events = [
    { name: "UserPromptSubmit", hasMatcher: false },
    { name: "PreToolUse", hasMatcher: true },
    { name: "PostToolUseFailure", hasMatcher: true },
    { name: "Stop", hasMatcher: false },
    { name: "Notification", hasMatcher: true },
  ];

  for (const { name, hasMatcher } of events) {
    if (!Array.isArray(settings.hooks[name])) settings.hooks[name] = [];

    // Remove any previously-installed pet hooks (idempotent re-setup)
    settings.hooks[name] = settings.hooks[name].filter(
      (rule) => !JSON.stringify(rule).includes(MARKER)
    );

    // Build our hook entry
    const hookCmd = getHookCommand();
    const entry = {
      hooks: [
        {
          type: "command",
          command: `${hookCmd} ${name}`,
          timeout: 10,
          async: true, // don't block Claude – we just write a file
        },
      ],
    };
    if (hasMatcher) entry.matcher = "";

    settings.hooks[name].push(entry);
  }

  // Write back
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

function removeHooks() {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  if (!fs.existsSync(settingsPath)) return;

  const MARKER = "claude-code-pet";
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch (e) {
    return;
  }
  if (!settings.hooks) return;

  for (const event of Object.keys(settings.hooks)) {
    if (Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = settings.hooks[event].filter(
        (rule) => !JSON.stringify(rule).includes(MARKER)
      );
    }
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

// ── Watchers ─────────────────────────────────────────────────────────────────

function initWatchers() {
  const config = require("./config");
  petConfig = config;
  config.load();
  const cfg = config.get();

  const { WatcherManager, PRIORITY } = require("./watchers/manager");
  const { IdleDetector } = require("./watchers/idle-detector");
  const { WindowTracker } = require("./watchers/window-tracker");
  const { SystemMonitor } = require("./watchers/system-monitor");
  const { PomodoroTimer } = require("./watchers/pomodoro");
  const { GitWatcher } = require("./watchers/git-watcher");
  const { BuildWatcher } = require("./watchers/build-watcher");
  const { SlackWatcher } = require("./watchers/slack");

  watcherManager = new WatcherManager({
    statusFile: STATUS_FILE,
    config: cfg,
    onStatusChange: (status, source) => {
      // Only change status if hook is not active
      if (!watcherManager.isHookActive()) {
        writeStatus(status);
      }
    },
    onMessage: (msg) => {
      enqueueMessage(msg);
    },
  });

  // Register watchers with their priorities
  const w = cfg.watchers;

  if (w.idleDetector.enabled) {
    watcherManager.register("idle", new IdleDetector(w.idleDetector), PRIORITY.IDLE);
  }
  if (w.windowTracker.enabled) {
    watcherManager.register("window", new WindowTracker(w.windowTracker), PRIORITY.WINDOW);
  }
  if (w.systemMonitor.enabled) {
    watcherManager.register("system", new SystemMonitor(w.systemMonitor), PRIORITY.SYSTEM);
  }
  if (w.pomodoro.enabled) {
    watcherManager.register("pomodoro", new PomodoroTimer(w.pomodoro), PRIORITY.POMODORO);
  }
  if (w.gitWatcher.enabled) {
    watcherManager.register("git", new GitWatcher(w.gitWatcher), PRIORITY.GIT);
  }
  if (w.buildWatcher.enabled) {
    watcherManager.register("build", new BuildWatcher(w.buildWatcher), PRIORITY.BUILD);
  }
  if (w.slack.enabled) {
    watcherManager.register("slack", new SlackWatcher(w.slack), PRIORITY.GIT); // same as git priority
  }

  // Weather watcher
  if (cfg.weather && cfg.weather.enabled) {
    const { WeatherWatcher } = require("./watchers/weather");
    watcherManager.register("weather", new WeatherWatcher(cfg.weather, (data) => {
      if (win) win.webContents.send("weather-update", data);
    }), PRIORITY.IDLE);
  }

  // Spotify watcher
  if (cfg.spotify && cfg.spotify.enabled && cfg.spotify.clientId) {
    const { SpotifyWatcher } = require("./watchers/spotify");
    watcherManager.register("spotify", new SpotifyWatcher(cfg.spotify, petConfig, (data) => {
      if (win) win.webContents.send("spotify-track", data);
    }), PRIORITY.IDLE);
  }

  // Notification watcher (Windows only)
  if (cfg.notifications && cfg.notifications.enabled && process.platform === "win32") {
    const { NotificationWatcher } = require("./watchers/notifications");
    watcherManager.register("notifications", new NotificationWatcher(cfg.notifications, (data) => {
      if (win) win.webContents.send("notification-msg", data);
    }), PRIORITY.GIT);
  }

  watcherManager.start();
}

function restartWatcherByName(name, enabled) {
  if (!petConfig) return;
  const cfg = petConfig.get();
  const { PRIORITY } = require("./watchers/manager");

  // Stop and remove existing
  const existing = watcherManager.getWatcher(name);
  if (existing) {
    existing.stop();
    watcherManager.watchers.delete(name);
  }

  if (!enabled) return;

  // Create and register new instance
  const w = cfg.watchers;
  let watcher, priority;

  switch (name) {
    case "idle": {
      const { IdleDetector } = require("./watchers/idle-detector");
      watcher = new IdleDetector(w.idleDetector);
      priority = PRIORITY.IDLE;
      break;
    }
    case "window": {
      const { WindowTracker } = require("./watchers/window-tracker");
      watcher = new WindowTracker(w.windowTracker);
      priority = PRIORITY.WINDOW;
      break;
    }
    case "system": {
      const { SystemMonitor } = require("./watchers/system-monitor");
      watcher = new SystemMonitor(w.systemMonitor);
      priority = PRIORITY.SYSTEM;
      break;
    }
    case "pomodoro": {
      const { PomodoroTimer } = require("./watchers/pomodoro");
      watcher = new PomodoroTimer(w.pomodoro);
      priority = PRIORITY.POMODORO;
      break;
    }
    case "git": {
      const { GitWatcher } = require("./watchers/git-watcher");
      watcher = new GitWatcher(w.gitWatcher);
      priority = PRIORITY.GIT;
      break;
    }
    case "build": {
      const { BuildWatcher } = require("./watchers/build-watcher");
      watcher = new BuildWatcher(w.buildWatcher);
      priority = PRIORITY.BUILD;
      break;
    }
    case "slack": {
      const { SlackWatcher } = require("./watchers/slack");
      watcher = new SlackWatcher(w.slack);
      priority = PRIORITY.GIT;
      break;
    }
    case "weather": {
      const { WeatherWatcher } = require("./watchers/weather");
      watcher = new WeatherWatcher(cfg.weather || {}, (data) => {
        if (win) win.webContents.send("weather-update", data);
      });
      priority = PRIORITY.IDLE;
      break;
    }
    case "spotify": {
      const { SpotifyWatcher } = require("./watchers/spotify");
      watcher = new SpotifyWatcher(cfg.spotify || {}, petConfig, (data) => {
        if (win) win.webContents.send("spotify-track", data);
      });
      priority = PRIORITY.IDLE;
      break;
    }
    case "notifications": {
      const { NotificationWatcher } = require("./watchers/notifications");
      watcher = new NotificationWatcher(cfg.notifications || {}, (data) => {
        if (win) win.webContents.send("notification-msg", data);
      });
      priority = PRIORITY.GIT;
      break;
    }
  }

  if (watcher) {
    watcherManager.register(name, watcher, priority);
    watcher.start();
  }
}

// ── Window ──────────────────────────────────────────────────────────────────

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width: 260,
    height: 300,
    x: width - 300,
    y: height - 320,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  win.loadFile("pet.html");
  win.setIgnoreMouseEvents(false);

  // ── SCREENSHOT DETECTION ─────────────────────────────────────────
  // Win+Shift+S (Snipping Tool) copies image to clipboard → poll for changes
  // Win+PrtScn saves to Screenshots folder → watch for new files
  let lastClipboardSize = "";
  let screenshotCooldown = false;

  function notifyScreenshot() {
    if (screenshotCooldown) return;
    screenshotCooldown = true;
    setTimeout(() => { screenshotCooldown = false; }, 4000);
    if (win && !win.isDestroyed()) {
      win.webContents.send("screenshot-taken");
    }
  }

  // Clipboard polling — catches Win+Shift+S (Snipping Tool)
  setInterval(() => {
    try {
      const img = clipboard.readImage();
      if (!img.isEmpty()) {
        const sz = img.getSize();
        const key = `${sz.width}x${sz.height}`;
        if (key !== lastClipboardSize) {
          lastClipboardSize = key;
          notifyScreenshot();
        }
      }
    } catch (e) { /* ignore */ }
  }, 800);

  // File watcher — catches Win+PrtScn (saves to Screenshots folder)
  const screenshotsDirs = [
    path.join(os.homedir(), "Pictures", "Screenshots"),
    path.join(os.homedir(), "OneDrive", "Pictures", "Screenshots"),
  ];
  for (const dir of screenshotsDirs) {
    if (fs.existsSync(dir)) {
      fs.watch(dir, (eventType, filename) => {
        if (filename && /\.(png|jpg|jpeg)$/i.test(filename)) {
          notifyScreenshot();
        }
      });
    }
  }

  // Watch status file for immediate reaction
  fs.watch(STATUS_FILE, () => {
    try {
      const status = fs.readFileSync(STATUS_FILE, "utf-8").trim();
      if (status !== currentStatus) {
        currentStatus = status;
        lastChangeTime = Date.now();
        win.webContents.send("status-change", status);
        win.webContents.send("status-update", {
          status: currentStatus,
          progression: progression.getState(),
        });
      }
    } catch (e) {
      // ignore
    }
  });

  // Poll every second as backup + handle auto-idle revert + XP ticks
  setInterval(() => {
    try {
      const status = fs.readFileSync(STATUS_FILE, "utf-8").trim();

      if (status !== currentStatus) {
        currentStatus = status;
        lastChangeTime = Date.now();
        win.webContents.send("status-change", status);
      }

      // Award XP for current activity (use variant when active)
      let tickActivity;
      if (currentActivityVariant && currentStatus !== "idle") {
        tickActivity = currentActivityVariant;
      } else if (currentStatus === "idle" && currentIdleVariant !== "idle") {
        tickActivity = currentIdleVariant;
      } else {
        tickActivity = currentStatus;
      }
      progression.tick(tickActivity);

      // Send progression update every tick so UI stays in sync
      win.webContents.send("status-update", {
        status: currentStatus,
        progression: progression.getState(),
      });

      const elapsed = Date.now() - lastChangeTime;

      // Auto-revert transient states → idle after timeout
      // But only if watchers aren't actively controlling status
      const watcherActive = watcherManager && !watcherManager.isHookActive() && watcherManager.currentSource;
      const quickRevert = ["success", "error"];
      const slowRevert = [
        "thinking", "coding", "searching", "reading", "debugging",
        "installing", "testing", "deploying", "cooking", "hatching",
        "deleting", "downloading",
      ];

      if (!watcherActive) {
        if (quickRevert.includes(currentStatus) && elapsed > 5000) {
          writeStatus("idle");
        } else if (slowRevert.includes(currentStatus) && elapsed > 120_000) {
          writeStatus("idle");
        }
      } else {
        // Still revert quick states even with watchers
        if (quickRevert.includes(currentStatus) && elapsed > 5000) {
          writeStatus("idle");
        }
      }

      // WhatsApp open detection — send one-time event when user switches to WhatsApp
      if (watcherManager) {
        const windowWatcher = watcherManager.getWatcher("window");
        if (windowWatcher) {
          const proc = windowWatcher.getCurrentProcess();
          if (proc && proc.toLowerCase().includes("whatsapp")) {
            if (!win._whatsappNotified) {
              win._whatsappNotified = true;
              win.webContents.send("whatsapp-active");
            }
          } else {
            win._whatsappNotified = false;
          }
        }
      }
    } catch (e) {
      // ignore
    }
  }, 1000);
}

// ── Tray ────────────────────────────────────────────────────────────────────

function formatTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function buildStatsSubmenu() {
  const s = progression.getState();
  const skillItems = Object.entries(s.skills)
    .filter(([, v]) => v.level > 1 || v.xp > 0)
    .sort((a, b) => b[1].level - a[1].level || b[1].xp - a[1].xp)
    .map(([name, v]) => ({
      label: `  ${name.charAt(0).toUpperCase() + name.slice(1)}: Lv ${v.level}`,
      enabled: false,
    }));
  if (skillItems.length === 0) {
    skillItems.push({ label: "  No skills leveled yet", enabled: false });
  }
  return [
    { label: `Level ${s.level} — ${s.tierName}`, enabled: false },
    { label: `XP: ${s.currentLevelXP.toLocaleString()} / ${s.nextLevelXP.toLocaleString()}`, enabled: false },
    { type: "separator" },
    ...skillItems,
    { type: "separator" },
    { label: `Time Active: ${formatTime(s.totalTimeMs)}`, enabled: false },
  ];
}

function buildWatchersSubmenu() {
  if (!petConfig) return [];
  const cfg = petConfig.get();
  const w = cfg.watchers;

  const items = [
    {
      label: "Idle Detection",
      type: "checkbox",
      checked: w.idleDetector.enabled,
      click: (mi) => {
        petConfig.set("watchers.idleDetector.enabled", mi.checked);
        restartWatcherByName("idle", mi.checked);
      },
    },
    {
      label: "Window Tracking",
      type: "checkbox",
      checked: w.windowTracker.enabled,
      click: (mi) => {
        petConfig.set("watchers.windowTracker.enabled", mi.checked);
        restartWatcherByName("window", mi.checked);
      },
    },
    {
      label: "CPU/RAM Monitor",
      type: "checkbox",
      checked: w.systemMonitor.enabled,
      click: (mi) => {
        petConfig.set("watchers.systemMonitor.enabled", mi.checked);
        restartWatcherByName("system", mi.checked);
      },
    },
    {
      label: "Pomodoro Timer",
      type: "checkbox",
      checked: w.pomodoro.enabled,
      click: (mi) => {
        petConfig.set("watchers.pomodoro.enabled", mi.checked);
        restartWatcherByName("pomodoro", mi.checked);
        refreshTray();
      },
    },
    {
      label: "Git Watcher",
      type: "checkbox",
      checked: w.gitWatcher.enabled,
      click: (mi) => {
        petConfig.set("watchers.gitWatcher.enabled", mi.checked);
        restartWatcherByName("git", mi.checked);
        refreshTray();
      },
    },
    {
      label: "Build Watcher",
      type: "checkbox",
      checked: w.buildWatcher.enabled,
      click: (mi) => {
        petConfig.set("watchers.buildWatcher.enabled", mi.checked);
        restartWatcherByName("build", mi.checked);
        refreshTray();
      },
    },
    {
      label: "Slack",
      type: "checkbox",
      checked: w.slack.enabled,
      click: (mi) => {
        petConfig.set("watchers.slack.enabled", mi.checked);
        restartWatcherByName("slack", mi.checked);
        refreshTray();
      },
    },
  ];

  // System monitor stats line
  const sysMon = watcherManager && watcherManager.getWatcher("system");
  if (sysMon) {
    items.push({ type: "separator" });
    items.push({
      label: `CPU: ${sysMon.getCpuPercent()}% | RAM: ${sysMon.getRamPercent()}%`,
      enabled: false,
    });
  }

  return items;
}

function buildPomodoroSubmenu() {
  const pomo = watcherManager && watcherManager.getWatcher("pomodoro");
  if (!pomo) return [];

  const items = [];
  if (pomo.isActive()) {
    const phase = pomo.getPhase();
    items.push({
      label: `${phase === "work" ? "Work" : "Break"}: ${pomo.formatTime()}`,
      enabled: false,
    });
    items.push({
      label: "Stop",
      click: () => { pomo.reset(); refreshTray(); },
    });
  } else {
    items.push({
      label: "Start Work",
      click: () => { pomo.startWork(); refreshTray(); },
    });
  }
  items.push({
    label: "Reset",
    click: () => { pomo.reset(); refreshTray(); },
  });

  return items;
}

function buildGitSubmenu() {
  const git = watcherManager && watcherManager.getWatcher("git");
  if (!git) return [];

  const items = [
    {
      label: "Select Repository...",
      click: () => {
        dialog.showOpenDialog({ properties: ["openDirectory"] }).then((result) => {
          if (!result.canceled && result.filePaths.length > 0) {
            const repoPath = result.filePaths[0];
            petConfig.set("watchers.gitWatcher.repoPath", repoPath);
            git.setRepoPath(repoPath);
            refreshTray();
          }
        });
      },
    },
  ];

  if (git.repoPath) {
    items.push({
      label: `Repo: ${path.basename(git.repoPath)}`,
      enabled: false,
    });
  }

  return items;
}

function buildBuildSubmenu() {
  const build = watcherManager && watcherManager.getWatcher("build");
  if (!build) return [];

  const items = [
    {
      label: "Select Folder...",
      click: () => {
        dialog.showOpenDialog({ properties: ["openDirectory"] }).then((result) => {
          if (!result.canceled && result.filePaths.length > 0) {
            const watchPath = result.filePaths[0];
            petConfig.set("watchers.buildWatcher.watchPath", watchPath);
            build.setWatchPath(watchPath);
            refreshTray();
          }
        });
      },
    },
  ];

  if (build.watchPath) {
    items.push({
      label: `Watching: ${path.basename(build.watchPath)}`,
      enabled: false,
    });
  }

  return items;
}

function buildSlackSubmenu() {
  const slack = watcherManager && watcherManager.getWatcher("slack");
  if (!slack) return [];

  const items = [
    {
      label: "Set Token...",
      click: () => {
        // Simple dialog for token input
        const tokenWin = new BrowserWindow({
          width: 420, height: 180,
          resizable: false,
          frame: true,
          alwaysOnTop: true,
          webPreferences: { nodeIntegration: true, contextIsolation: false },
        });
        tokenWin.setMenuBarVisibility(false);
        const html = `<!DOCTYPE html><html><body style="font-family:Segoe UI;padding:16px;background:#1e1e2e;color:#cdd6f4">
          <p style="margin:0 0 8px">Slack Bot Token (xoxb-...):</p>
          <input id="t" type="text" style="width:100%;padding:6px;background:#313244;color:#cdd6f4;border:1px solid #585b70;border-radius:4px" placeholder="xoxb-your-token-here" value="${slack.token || ""}">
          <div style="margin-top:12px;text-align:right">
            <button onclick="save()" style="padding:6px 16px;background:#89b4fa;color:#1e1e2e;border:none;border-radius:4px;cursor:pointer">Save</button>
            <button onclick="window.close()" style="padding:6px 16px;background:#585b70;color:#cdd6f4;border:none;border-radius:4px;cursor:pointer;margin-left:8px">Cancel</button>
          </div>
          <script>const{ipcRenderer}=require("electron");function save(){ipcRenderer.send("slack-token-set",document.getElementById("t").value);window.close()}</script>
        </body></html>`;
        tokenWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
      },
    },
    {
      label: slack.isConnected() ? "Status: Connected" : "Status: Disconnected",
      enabled: false,
    },
    {
      label: "Show Messages",
      type: "checkbox",
      checked: slack.showMessages,
      click: (mi) => { slack.showMessages = mi.checked; },
    },
  ];

  return items;
}

function buildPersonalizeSubmenu() {
  const cfg = petConfig ? petConfig.get() : {};
  const currentName = cfg.petName || "";
  const items = [
    {
      label: currentName ? `Name: ${currentName}` : "Set Name...",
      click: () => {
        const nameWin = new BrowserWindow({
          width: 380, height: 160,
          resizable: false, frame: true, alwaysOnTop: true,
          webPreferences: { nodeIntegration: true, contextIsolation: false },
        });
        nameWin.setMenuBarVisibility(false);
        const html = `<!DOCTYPE html><html><body style="font-family:Segoe UI;padding:16px;background:#1e1e2e;color:#cdd6f4">
          <p style="margin:0 0 8px">Pet companion name:</p>
          <input id="n" type="text" style="width:100%;padding:6px;background:#313244;color:#cdd6f4;border:1px solid #585b70;border-radius:4px" placeholder="e.g. Miko" value="${currentName}">
          <div style="margin-top:12px;text-align:right">
            <button onclick="save()" style="padding:6px 16px;background:#f5a0c0;color:#1e1e2e;border:none;border-radius:4px;cursor:pointer;font-weight:bold">Save</button>
            <button onclick="window.close()" style="padding:6px 16px;background:#585b70;color:#cdd6f4;border:none;border-radius:4px;cursor:pointer;margin-left:8px">Cancel</button>
          </div>
          <script>const{ipcRenderer}=require("electron");function save(){ipcRenderer.send("pet-name-set",document.getElementById("n").value.trim());window.close()}</script>
        </body></html>`;
        nameWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
      },
    },
    {
      label: "Add Custom Message...",
      click: () => {
        const msgWin = new BrowserWindow({
          width: 420, height: 160,
          resizable: false, frame: true, alwaysOnTop: true,
          webPreferences: { nodeIntegration: true, contextIsolation: false },
        });
        msgWin.setMenuBarVisibility(false);
        const html = `<!DOCTYPE html><html><body style="font-family:Segoe UI;padding:16px;background:#1e1e2e;color:#cdd6f4">
          <p style="margin:0 0 8px">Add encouragement message:</p>
          <input id="m" type="text" style="width:100%;padding:6px;background:#313244;color:#cdd6f4;border:1px solid #585b70;border-radius:4px" placeholder="e.g. You're the best coder ever!">
          <div style="margin-top:12px;text-align:right">
            <button onclick="save()" style="padding:6px 16px;background:#f5a0c0;color:#1e1e2e;border:none;border-radius:4px;cursor:pointer;font-weight:bold">Add</button>
            <button onclick="window.close()" style="padding:6px 16px;background:#585b70;color:#cdd6f4;border:none;border-radius:4px;cursor:pointer;margin-left:8px">Cancel</button>
          </div>
          <script>const{ipcRenderer}=require("electron");function save(){const v=document.getElementById("m").value.trim();if(v)ipcRenderer.send("pet-custom-msg",v);window.close()}</script>
        </body></html>`;
        msgWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
      },
    },
    {
      label: "Add Special Date...",
      click: () => {
        const dateWin = new BrowserWindow({
          width: 420, height: 200,
          resizable: false, frame: true, alwaysOnTop: true,
          webPreferences: { nodeIntegration: true, contextIsolation: false },
        });
        dateWin.setMenuBarVisibility(false);
        const html = `<!DOCTYPE html><html><body style="font-family:Segoe UI;padding:16px;background:#1e1e2e;color:#cdd6f4">
          <p style="margin:0 0 8px">Special date (shown yearly):</p>
          <div style="display:flex;gap:8px;margin-bottom:8px">
            <input id="d" type="text" style="width:100px;padding:6px;background:#313244;color:#cdd6f4;border:1px solid #585b70;border-radius:4px" placeholder="MM-DD">
            <input id="msg" type="text" style="flex:1;padding:6px;background:#313244;color:#cdd6f4;border:1px solid #585b70;border-radius:4px" placeholder="Happy Anniversary! 🎉">
          </div>
          <p style="margin:0 0 8px;font-size:10px;color:#888">Format: 2-14 for Feb 14, 12-25 for Dec 25</p>
          <div style="text-align:right">
            <button onclick="save()" style="padding:6px 16px;background:#f5a0c0;color:#1e1e2e;border:none;border-radius:4px;cursor:pointer;font-weight:bold">Add</button>
            <button onclick="window.close()" style="padding:6px 16px;background:#585b70;color:#cdd6f4;border:none;border-radius:4px;cursor:pointer;margin-left:8px">Cancel</button>
          </div>
          <script>const{ipcRenderer}=require("electron");function save(){const d=document.getElementById("d").value.trim(),m=document.getElementById("msg").value.trim();if(d&&m)ipcRenderer.send("pet-special-date",{date:d,message:m});window.close()}</script>
        </body></html>`;
        dateWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
      },
    },
  ];

  // Show existing custom messages count
  const msgs = cfg.customMessages || [];
  if (msgs.length > 0) {
    items.push({ label: `${msgs.length} custom message(s)`, enabled: false });
  }

  // Show existing special dates
  const dates = cfg.specialDates || [];
  for (const d of dates) {
    items.push({ label: `📅 ${d.date}: ${d.message.substring(0, 25)}`, enabled: false });
  }

  return items;
}

function buildSoundSubmenu() {
  if (!petConfig) return [];
  const cfg = petConfig.get();
  return [
    {
      label: "Sound Enabled",
      type: "checkbox",
      checked: cfg.soundEnabled !== false,
      click: (mi) => {
        petConfig.set("soundEnabled", mi.checked);
        if (win) win.webContents.send("sound-config", { enabled: mi.checked });
      },
    },
    { type: "separator" },
    {
      label: "Volume: 100%",
      type: "radio",
      checked: (cfg.soundVolume || 0.7) >= 0.95,
      click: () => {
        petConfig.set("soundVolume", 1.0);
        if (win) win.webContents.send("sound-config", { volume: 1.0 });
        refreshTray();
      },
    },
    {
      label: "Volume: 70%",
      type: "radio",
      checked: (cfg.soundVolume || 0.7) >= 0.65 && (cfg.soundVolume || 0.7) < 0.95,
      click: () => {
        petConfig.set("soundVolume", 0.7);
        if (win) win.webContents.send("sound-config", { volume: 0.7 });
        refreshTray();
      },
    },
    {
      label: "Volume: 40%",
      type: "radio",
      checked: (cfg.soundVolume || 0.7) >= 0.35 && (cfg.soundVolume || 0.7) < 0.65,
      click: () => {
        petConfig.set("soundVolume", 0.4);
        if (win) win.webContents.send("sound-config", { volume: 0.4 });
        refreshTray();
      },
    },
    {
      label: "Volume: 10%",
      type: "radio",
      checked: (cfg.soundVolume || 0.7) < 0.35,
      click: () => {
        petConfig.set("soundVolume", 0.1);
        if (win) win.webContents.send("sound-config", { volume: 0.1 });
        refreshTray();
      },
    },
  ];
}

function buildWeatherSubmenu() {
  if (!petConfig) return [];
  const cfg = petConfig.get();
  const weather = cfg.weather || {};
  return [
    {
      label: "Weather Enabled",
      type: "checkbox",
      checked: weather.enabled || false,
      click: (mi) => {
        petConfig.set("weather.enabled", mi.checked);
        restartWatcherByName("weather", mi.checked);
        refreshTray();
      },
    },
    {
      label: "Set Location...",
      click: () => {
        const locWin = new BrowserWindow({
          width: 420, height: 180,
          resizable: false, frame: true, alwaysOnTop: true,
          webPreferences: { nodeIntegration: true, contextIsolation: false },
        });
        locWin.setMenuBarVisibility(false);
        const html = `<!DOCTYPE html><html><body style="font-family:Segoe UI;padding:16px;background:#1e1e2e;color:#cdd6f4">
          <p style="margin:0 0 8px">City name:</p>
          <input id="city" type="text" style="width:100%;padding:6px;background:#313244;color:#cdd6f4;border:1px solid #585b70;border-radius:4px" placeholder="e.g. Helsinki" value="${weather.cityName || ""}">
          <p id="status" style="margin:8px 0 0;font-size:11px;color:#888"></p>
          <div style="margin-top:12px;text-align:right">
            <button id="saveBtn" onclick="save()" style="padding:6px 16px;background:#48dbfb;color:#1e1e2e;border:none;border-radius:4px;cursor:pointer;font-weight:bold">Save</button>
            <button onclick="window.close()" style="padding:6px 16px;background:#585b70;color:#cdd6f4;border:none;border-radius:4px;cursor:pointer;margin-left:8px">Cancel</button>
          </div>
          <script>const{ipcRenderer}=require("electron");function save(){const city=document.getElementById("city").value.trim();if(!city)return;document.getElementById("status").textContent="Looking up coordinates...";document.getElementById("saveBtn").disabled=true;ipcRenderer.send("weather-location-set",{city,lat:NaN,lon:NaN});window.close()}</script>
        </body></html>`;
        locWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
      },
    },
    {
      label: weather.cityName ? `Location: ${weather.cityName}` : "Location: Not set",
      enabled: false,
    },
    {
      label: "Show Temperature",
      type: "checkbox",
      checked: weather.showTemperature !== false,
      click: (mi) => {
        petConfig.set("weather.showTemperature", mi.checked);
      },
    },
  ];
}

function buildSpotifySubmenu() {
  if (!petConfig) return [];
  const cfg = petConfig.get();
  const spotify = cfg.spotify || {};
  const spotifyWatcher = watcherManager && watcherManager.getWatcher("spotify");
  const isConnected = spotifyWatcher && spotifyWatcher.isConnected && spotifyWatcher.isConnected();
  const currentTrack = spotifyWatcher && spotifyWatcher.getCurrentTrack && spotifyWatcher.getCurrentTrack();

  const items = [
    {
      label: spotify.enabled ? "Disconnect Spotify" : "Connect Spotify...",
      click: () => {
        if (spotify.enabled && spotify.refreshToken) {
          petConfig.set("spotify.enabled", false);
          petConfig.set("spotify.accessToken", null);
          petConfig.set("spotify.refreshToken", null);
          restartWatcherByName("spotify", false);
          refreshTray();
        } else {
          // Open setup dialog for client credentials
          const spotWin = new BrowserWindow({
            width: 460, height: 260,
            resizable: false, frame: true, alwaysOnTop: true,
            webPreferences: { nodeIntegration: true, contextIsolation: false },
          });
          spotWin.setMenuBarVisibility(false);
          const html = `<!DOCTYPE html><html><body style="font-family:Segoe UI;padding:16px;background:#1e1e2e;color:#cdd6f4">
            <p style="margin:0 0 8px;font-weight:bold">Spotify Developer Credentials</p>
            <p style="margin:0 0 8px;font-size:11px;color:#888">Create an app at developer.spotify.com/dashboard</p>
            <p style="margin:0 0 4px;font-size:12px">Client ID:</p>
            <input id="cid" type="text" style="width:100%;padding:6px;background:#313244;color:#cdd6f4;border:1px solid #585b70;border-radius:4px" value="${spotify.clientId || ""}">
            <p style="margin:8px 0 4px;font-size:12px">Client Secret:</p>
            <input id="csec" type="password" style="width:100%;padding:6px;background:#313244;color:#cdd6f4;border:1px solid #585b70;border-radius:4px" value="${spotify.clientSecret || ""}">
            <div style="margin-top:12px;text-align:right">
              <button onclick="save()" style="padding:6px 16px;background:#1DB954;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:bold">Connect</button>
              <button onclick="window.close()" style="padding:6px 16px;background:#585b70;color:#cdd6f4;border:none;border-radius:4px;cursor:pointer;margin-left:8px">Cancel</button>
            </div>
            <script>const{ipcRenderer}=require("electron");function save(){ipcRenderer.send("spotify-credentials-set",{clientId:document.getElementById("cid").value.trim(),clientSecret:document.getElementById("csec").value.trim()});window.close()}</script>
          </body></html>`;
          spotWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
        }
      },
    },
    {
      label: isConnected ? "Status: Connected" : "Status: Disconnected",
      enabled: false,
    },
  ];

  if (currentTrack) {
    items.push({
      label: `Playing: ${currentTrack.name} - ${currentTrack.artist}`,
      enabled: false,
    });
  }

  items.push({
    label: "Show Song Changes",
    type: "checkbox",
    checked: spotify.showSongChanges !== false,
    click: (mi) => {
      petConfig.set("spotify.showSongChanges", mi.checked);
    },
  });

  return items;
}

function buildNotificationsSubmenu() {
  if (!petConfig) return [];
  const cfg = petConfig.get();
  const notif = cfg.notifications || {};
  return [
    {
      label: "Notifications Enabled",
      type: "checkbox",
      checked: notif.enabled || false,
      click: (mi) => {
        petConfig.set("notifications.enabled", mi.checked);
        restartWatcherByName("notifications", mi.checked);
        refreshTray();
      },
    },
    {
      label: notif.specialPersonName ? `Special Person: ${notif.specialPersonName}` : "Set Special Person...",
      click: () => {
        const nWin = new BrowserWindow({
          width: 380, height: 160,
          resizable: false, frame: true, alwaysOnTop: true,
          webPreferences: { nodeIntegration: true, contextIsolation: false },
        });
        nWin.setMenuBarVisibility(false);
        const html = `<!DOCTYPE html><html><body style="font-family:Segoe UI;padding:16px;background:#1e1e2e;color:#cdd6f4">
          <p style="margin:0 0 8px">Special person's name (as shown in WhatsApp):</p>
          <input id="n" type="text" style="width:100%;padding:6px;background:#313244;color:#cdd6f4;border:1px solid #585b70;border-radius:4px" placeholder="e.g. My Love" value="${notif.specialPersonName || ""}">
          <div style="margin-top:12px;text-align:right">
            <button onclick="save()" style="padding:6px 16px;background:#f5a0c0;color:#1e1e2e;border:none;border-radius:4px;cursor:pointer;font-weight:bold">Save</button>
            <button onclick="window.close()" style="padding:6px 16px;background:#585b70;color:#cdd6f4;border:none;border-radius:4px;cursor:pointer;margin-left:8px">Cancel</button>
          </div>
          <script>const{ipcRenderer}=require("electron");function save(){ipcRenderer.send("notification-person-set",document.getElementById("n").value.trim());window.close()}</script>
        </body></html>`;
        nWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
      },
    },
    {
      label: "Show Message Preview",
      type: "checkbox",
      checked: notif.showPreview || false,
      click: (mi) => {
        petConfig.set("notifications.showPreview", mi.checked);
      },
    },
  ];
}

function buildPhotosSubmenu() {
  if (!petConfig) return [];
  const cfg = petConfig.get();
  const photos = cfg.photos || {};
  return [
    {
      label: "Photo Frame Enabled",
      type: "checkbox",
      checked: photos.enabled || false,
      click: (mi) => {
        petConfig.set("photos.enabled", mi.checked);
        if (win) win.webContents.send("photo-config", { enabled: mi.checked, folder: photos.folderPath });
        refreshTray();
      },
    },
    {
      label: "Set Photo Folder...",
      click: () => {
        dialog.showOpenDialog({ properties: ["openDirectory"] }).then((result) => {
          if (!result.canceled && result.filePaths.length > 0) {
            const folder = result.filePaths[0];
            petConfig.set("photos.folderPath", folder);
            if (win) win.webContents.send("photo-config", { enabled: photos.enabled, folder });
            refreshTray();
          }
        });
      },
    },
    {
      label: photos.folderPath ? `Folder: ${path.basename(photos.folderPath)}` : "Folder: Not set",
      enabled: false,
    },
  ];
}

function buildTrayMenu(hooksActive) {
  const cfg = petConfig ? petConfig.get() : null;
  const template = [
    {
      label: hooksActive ? "Auto-detect Active" : "Auto-detect Off",
      enabled: false,
    },
    {
      label: "Re-setup Hooks",
      click: () => {
        try {
          setupHooks();
          hooksActiveGlobal = true;
          refreshTray();
          dialog.showMessageBox({
            message:
              "Hooks installed successfully!\nRestart any running Claude Code sessions for changes to take effect.",
            type: "info",
            title: "Claude Code Pet",
          });
        } catch (e) {
          dialog.showErrorBox("Hook Setup Failed", e.message);
        }
      },
    },
    {
      label: "Remove Hooks",
      click: () => {
        try {
          removeHooks();
          hooksActiveGlobal = false;
          refreshTray();
        } catch (e) {
          // ignore
        }
      },
    },
    { type: "separator" },
    {
      label: "Watchers",
      submenu: buildWatchersSubmenu(),
    },
    // Skin selection removed — only Anu (girlfriend)
  ];

  // Pomodoro submenu (only if enabled)
  if (cfg && cfg.watchers.pomodoro.enabled) {
    template.push({
      label: "Pomodoro",
      submenu: buildPomodoroSubmenu(),
    });
  }

  // Git submenu (only if enabled)
  if (cfg && cfg.watchers.gitWatcher.enabled) {
    template.push({
      label: "Git",
      submenu: buildGitSubmenu(),
    });
  }

  // Build submenu (only if enabled)
  if (cfg && cfg.watchers.buildWatcher.enabled) {
    template.push({
      label: "Build",
      submenu: buildBuildSubmenu(),
    });
  }

  // Slack submenu (only if enabled)
  if (cfg && cfg.watchers.slack.enabled) {
    template.push({
      label: "Slack",
      submenu: buildSlackSubmenu(),
    });
  }

  // Sound submenu
  template.push({
    label: "Sound",
    submenu: buildSoundSubmenu(),
  });

  // Spotify submenu
  template.push({
    label: "Spotify",
    submenu: buildSpotifySubmenu(),
  });

  // Weather submenu
  template.push({
    label: "Weather",
    submenu: buildWeatherSubmenu(),
  });

  // Notifications submenu
  template.push({
    label: "Notifications",
    submenu: buildNotificationsSubmenu(),
  });

  // Photos submenu
  template.push({
    label: "Photos",
    submenu: buildPhotosSubmenu(),
  });

  template.push({ type: "separator" });
  template.push({
    label: "Stats",
    submenu: buildStatsSubmenu(),
  });
  template.push({
    label: "Personalize",
    submenu: buildPersonalizeSubmenu(),
  });
  template.push({ type: "separator" });
  template.push({
    label: "Manual",
    submenu: [
      { label: "Idle", click: () => writeStatus("idle") },
      { label: "Thinking", click: () => writeStatus("thinking") },
      { label: "Coding", click: () => writeStatus("coding") },
      { label: "Success", click: () => writeStatus("success") },
      { label: "Error", click: () => writeStatus("error") },
      { type: "separator" },
      { label: "Searching", click: () => writeStatus("searching") },
      { label: "Reading", click: () => writeStatus("reading") },
      { label: "Debugging", click: () => writeStatus("debugging") },
      { label: "Installing", click: () => writeStatus("installing") },
      { label: "Testing", click: () => writeStatus("testing") },
      { label: "Deploying", click: () => writeStatus("deploying") },
      { label: "Cooking", click: () => writeStatus("cooking") },
      { label: "Hatching", click: () => writeStatus("hatching") },
      { label: "Deleting", click: () => writeStatus("deleting") },
      { label: "Downloading", click: () => writeStatus("downloading") },
    ],
  });
  template.push({ type: "separator" });
  template.push({ label: "Quit", click: () => app.quit() });

  return Menu.buildFromTemplate(template);
}

let hooksActiveGlobal = false;
let currentSkinGlobal = "girlfriend";

function setSkin(skin) {
  console.log("[Skin] setSkin called:", skin);
  currentSkinGlobal = skin;
  if (petConfig) {
    petConfig.set("skin", skin);
    console.log("[Skin] Saved to config");
  }
  if (win) {
    win.webContents.send("skin-change", skin);
    console.log("[Skin] Sent skin-change IPC to renderer");
  }
}

function buildSkinSubmenu() {
  return [{
    label: "Girlfriend Anu",
    type: "radio",
    checked: true,
    click: () => {},
  }];
}

function refreshTray() {
  if (tray) {
    try { tray.setContextMenu(buildTrayMenu(hooksActiveGlobal)); } catch (e) { /* ignore */ }
  }
}

// ── App lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(() => {
  if (IS_HOOK_MODE) return; // Hook runner handles everything above

  // Load progression data
  progression.load();

  // Window drag via JS — main process polls cursor so drag works even when
  // mouse leaves the renderer window boundary
  let dragPollInterval = null;
  let dragSafetyTimer = null;
  let wdStartWinPos = null;
  let wdStartCursor = null;

  function stopDragPoll() {
    if (dragPollInterval) { clearInterval(dragPollInterval); dragPollInterval = null; }
    if (dragSafetyTimer) { clearTimeout(dragSafetyTimer); dragSafetyTimer = null; }
    wdStartWinPos = null;
    wdStartCursor = null;
  }

  ipcMain.on("drag-window-start", () => {
    stopDragPoll();
    wdStartWinPos = win.getPosition();
    const cur = screen.getCursorScreenPoint();
    wdStartCursor = { x: cur.x, y: cur.y };
    dragPollInterval = setInterval(() => {
      if (!wdStartWinPos || !wdStartCursor) return;
      const cur = screen.getCursorScreenPoint();
      win.setPosition(
        Math.round(wdStartWinPos[0] + cur.x - wdStartCursor.x),
        Math.round(wdStartWinPos[1] + cur.y - wdStartCursor.y)
      );
    }, 8); // ~120fps
    // Safety: auto-stop after 30s in case renderer misses pointerup
    dragSafetyTimer = setTimeout(stopDragPoll, 30000);
  });
  ipcMain.on("drag-window-stop", stopDragPoll);

  ipcMain.on("app-close", () => { app.quit(); });

  // Listen for idle variant changes from the renderer
  ipcMain.on("idle-variant-change", (e, variant) => {
    currentIdleVariant = variant;
  });

  // Listen for activity variant changes from the renderer
  ipcMain.on("activity-variant-change", (e, variant) => {
    currentActivityVariant = variant;
  });

  // Listen for Slack token set
  ipcMain.on("slack-token-set", (e, token) => {
    if (petConfig) {
      petConfig.set("watchers.slack.token", token);
      const slack = watcherManager && watcherManager.getWatcher("slack");
      if (slack) slack.setToken(token);
      refreshTray();
    }
  });

  // Listen for pet interaction events (clicks etc.) from renderer
  ipcMain.on("pet-interaction", (e, data) => {
    if (data.type === "message") {
      enqueueMessage({ text: data.text, source: data.source, duration: data.duration || calcDuration(data.text), html: data.html });
    }
  });

  // Personalization IPC handlers
  ipcMain.on("pet-name-set", (e, name) => {
    if (petConfig) {
      petConfig.set("petName", name);
      // Send updated config to renderer
      if (win) {
        const cfg = petConfig.get();
        win.webContents.send("pet-config", {
          name: cfg.petName || "",
          customMessages: cfg.customMessages || [],
          specialDates: cfg.specialDates || [],
        });
      }
      refreshTray();
    }
  });

  ipcMain.on("pet-custom-msg", (e, msg) => {
    if (petConfig) {
      const cfg = petConfig.get();
      const msgs = cfg.customMessages || [];
      msgs.push(msg);
      petConfig.set("customMessages", msgs);
      // Send updated config to renderer
      if (win) {
        win.webContents.send("pet-config", {
          name: cfg.petName || "",
          customMessages: msgs,
          specialDates: cfg.specialDates || [],
        });
      }
      refreshTray();
    }
  });

  ipcMain.on("pet-special-date", (e, data) => {
    if (petConfig) {
      const cfg = petConfig.get();
      const dates = cfg.specialDates || [];
      dates.push({ date: data.date, message: data.message });
      petConfig.set("specialDates", dates);
      // Send updated config to renderer
      if (win) {
        win.webContents.send("pet-config", {
          name: cfg.petName || "",
          customMessages: cfg.customMessages || [],
          specialDates: dates,
        });
      }
      refreshTray();
    }
  });

  // Weather location set (with auto-geocoding)
  ipcMain.on("weather-location-set", async (e, data) => {
    if (!petConfig) return;
    petConfig.set("weather.cityName", data.city || "");

    let lat = data.lat;
    let lon = data.lon;

    // If lat/lon are missing but city is provided, auto-geocode
    if ((isNaN(lat) || isNaN(lon)) && data.city) {
      try {
        const { WeatherWatcher } = require("./watchers/weather");
        const coords = await WeatherWatcher.geocodeCity(data.city);
        if (coords) {
          lat = coords.latitude;
          lon = coords.longitude;
          // Update city name with the canonical name from geocoding
          if (coords.name) petConfig.set("weather.cityName", coords.name);
        }
      } catch (err) {
        console.error("[Weather] Geocoding failed:", err.message);
      }
    }

    if (!isNaN(lat) && !isNaN(lon)) {
      petConfig.set("weather.latitude", lat);
      petConfig.set("weather.longitude", lon);
      const weatherWatcher = watcherManager && watcherManager.getWatcher("weather");
      if (weatherWatcher) weatherWatcher.updateLocation(lat, lon);
    }
    refreshTray();
  });

  // Spotify credentials set → start OAuth flow
  ipcMain.on("spotify-credentials-set", (e, data) => {
    if (petConfig) {
      petConfig.set("spotify.clientId", data.clientId);
      petConfig.set("spotify.clientSecret", data.clientSecret);
      petConfig.set("spotify.enabled", true);
      restartWatcherByName("spotify", true);
      refreshTray();
    }
  });

  // Notification special person set
  ipcMain.on("notification-person-set", (e, name) => {
    if (petConfig) {
      petConfig.set("notifications.specialPersonName", name);
      const notifWatcher = watcherManager && watcherManager.getWatcher("notifications");
      if (notifWatcher) notifWatcher.setSpecialPerson(name);
      refreshTray();
    }
  });

  // Love meter update from renderer
  ipcMain.on("love-meter-save", (e, data) => {
    if (petConfig) {
      petConfig.set("loveMeter", data);
    }
  });

  // ── DEBUG LOGGER ────────────────────────────────────────────────
  const DEBUG_LOG_PATH = path.join(__dirname, "debug.log");
  const DEBUG_MAX_BYTES = 2 * 1024 * 1024; // 2 MB max, then rotate
  ipcMain.on("debug-log", (e, entry) => {
    try {
      const line = JSON.stringify(entry) + "\n";
      // Rotate if too large
      try {
        const stat = fs.statSync(DEBUG_LOG_PATH);
        if (stat.size > DEBUG_MAX_BYTES) {
          fs.renameSync(DEBUG_LOG_PATH, DEBUG_LOG_PATH + ".old");
        }
      } catch (_) {}
      fs.appendFileSync(DEBUG_LOG_PATH, line);
    } catch (_) {}
  });
  ipcMain.handle("debug-log-path", () => DEBUG_LOG_PATH);

  // Auto-setup hooks on launch
  try {
    setupHooks();
    hooksActiveGlobal = true;
  } catch (e) {
    console.error("Could not auto-setup hooks:", e.message);
  }

  createWindow();

  // Initialize watcher system (also loads petConfig)
  initWatchers();

  // Only Anu — force girlfriend skin always
  currentSkinGlobal = "girlfriend";
  if (petConfig) petConfig.set("skin", "girlfriend");
  // Resolve asset base path for sprite skins
  // __dirname works in both dev and packaged (Electron reads inside asar transparently)
  const assetsBasePath = path.join(__dirname, "assets");

  win.webContents.on("did-finish-load", () => {
    // Send the assets base path so renderer can resolve sprite image paths
    win.webContents.send("assets-path", assetsBasePath.replace(/\\/g, "/"));
    console.log("[Skin] did-finish-load — sending skin:", currentSkinGlobal);
    win.webContents.send("skin-change", currentSkinGlobal);
    // Send personalization config to renderer
    const cfg = petConfig ? petConfig.get() : {};
    win.webContents.send("pet-config", {
      name: cfg.petName || "",
      customMessages: cfg.customMessages || [],
      specialDates: cfg.specialDates || [],
    });
    // Send sound config
    win.webContents.send("sound-config", {
      enabled: cfg.soundEnabled !== false,
      volume: cfg.soundVolume || 0.7,
    });
    // Send love meter state
    win.webContents.send("love-meter-init", cfg.loveMeter || { points: 0, level: 1 });
    // Send photo config
    if (cfg.photos && cfg.photos.enabled && cfg.photos.folderPath) {
      win.webContents.send("photo-config", { enabled: true, folder: cfg.photos.folderPath });
    }
  });

  // System tray
  tray = new Tray(path.join(__dirname, "icon.png"));
  tray.setToolTip("Claude Code Pet");
  tray.setContextMenu(buildTrayMenu(hooksActiveGlobal));

  // Tray click: show/focus the window
  tray.on("click", () => {
    if (win) {
      if (win.isVisible()) {
        win.focus();
      } else {
        win.show();
      }
      // Bounds check: if off-screen, reset to bottom-right
      const { width, height } = screen.getPrimaryDisplay().workAreaSize;
      const [wx, wy] = win.getPosition();
      if (wx < -100 || wy < -100 || wx > width + 50 || wy > height + 50) {
        win.setPosition(width - 300, height - 320);
      }
    }
  });

  // Tray double-click: show + reset position
  tray.on("double-click", () => {
    if (win) {
      win.show();
      win.focus();
      const { width, height } = screen.getPrimaryDisplay().workAreaSize;
      win.setPosition(width - 300, height - 320);
    }
  });

  // Refresh tray menu periodically so stats stay current
  setInterval(() => {
    refreshTray();
  }, 15000);
});

function writeStatus(s) {
  fs.writeFileSync(STATUS_FILE, s);
}

app.on("before-quit", () => {
  progression.shutdown();
  if (watcherManager) watcherManager.stop();
  if (petConfig) petConfig.save();
});

app.on("window-all-closed", () => app.quit());
