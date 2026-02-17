// main.js - Electron main process
const { app, BrowserWindow, Tray, Menu, screen, dialog, ipcMain } = require("electron");
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
let bubbleExpanded = false;

// ── Message Queue ────────────────────────────────────────────────────────────

const messageQueue = [];
let messageProcessing = false;
const MAX_QUEUE = 5;

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
  showMessage(msg.text, msg.source, msg.duration || 8000);
  setTimeout(processMessageQueue, 500);
}

function showMessage(text, source, duration) {
  if (!win) return;
  // Expand window upward for speech bubble
  if (!bubbleExpanded) {
    const bounds = win.getBounds();
    win.setBounds({ x: bounds.x, y: bounds.y - 80, width: 200, height: 300 });
    bubbleExpanded = true;
  }
  win.webContents.send("show-message", { text, source, duration });
  setTimeout(() => hideMessage(), duration);
}

function hideMessage() {
  if (!win) return;
  win.webContents.send("hide-message");
  // Shrink window back after animation
  setTimeout(() => {
    if (!win || messageQueue.length > 0) return;
    if (bubbleExpanded) {
      const bounds = win.getBounds();
      win.setBounds({ x: bounds.x, y: bounds.y + 80, width: 200, height: 220 });
      bubbleExpanded = false;
    }
  }, 400);
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
    width: 200,
    height: 220,
    x: width - 220,
    y: height - 240,
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
    {
      label: "Skin",
      submenu: buildSkinSubmenu(),
    },
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

  template.push({ type: "separator" });
  template.push({
    label: "Stats",
    submenu: buildStatsSubmenu(),
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
let currentSkinGlobal = "default";

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
  const skins = [
    { id: "default", label: "Default Blob" },
    { id: "lego", label: "LEGO Minifig" },
    { id: "buddha", label: "Buddha" },
    { id: "anime", label: "Anime Girl" },
  ];
  return skins.map(s => ({
    label: s.label,
    type: "radio",
    checked: currentSkinGlobal === s.id,
    click: () => {
      setSkin(s.id);
      refreshTray();
    },
  }));
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

  // Restore saved skin on load
  const savedSkin = petConfig ? petConfig.get().skin : "default";
  currentSkinGlobal = savedSkin || "default";
  console.log("[Skin] Startup — restored skin from config:", currentSkinGlobal);
  win.webContents.on("did-finish-load", () => {
    console.log("[Skin] did-finish-load — sending skin:", currentSkinGlobal);
    if (currentSkinGlobal !== "default") {
      win.webContents.send("skin-change", currentSkinGlobal);
    }
  });

  // System tray
  tray = new Tray(path.join(__dirname, "icon.png"));
  tray.setToolTip("Claude Code Pet");
  tray.setContextMenu(buildTrayMenu(hooksActiveGlobal));

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
