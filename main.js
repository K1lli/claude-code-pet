// main.js - Electron main process
const { app, BrowserWindow, Tray, Menu, screen, dialog, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

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

let win, tray;
let currentStatus = "idle";
let lastChangeTime = Date.now();
let currentIdleVariant = "idle";
let currentActivityVariant = null;

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

function setupHooks() {
  const hookPath = getHookPath();
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

    // Build our hook entry – use absolute node path so hooks work in VS Code
    const nodeBin = getNodePath();
    const entry = {
      hooks: [
        {
          type: "command",
          command: `"${nodeBin}" "${hookPath}" ${name}`,
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
      const quickRevert = ["success", "error"];
      const slowRevert = [
        "thinking", "coding", "searching", "reading", "debugging",
        "installing", "testing", "deploying", "cooking", "hatching",
        "deleting", "downloading",
      ];

      if (quickRevert.includes(currentStatus) && elapsed > 5000) {
        writeStatus("idle");
      } else if (slowRevert.includes(currentStatus) && elapsed > 120_000) {
        writeStatus("idle");
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

function buildTrayMenu(hooksActive) {
  return Menu.buildFromTemplate([
    {
      label: hooksActive ? "Auto-detect Active" : "Auto-detect Off",
      enabled: false,
    },
    {
      label: "Re-setup Hooks",
      click: () => {
        try {
          setupHooks();
          tray.setContextMenu(buildTrayMenu(true));
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
          tray.setContextMenu(buildTrayMenu(false));
        } catch (e) {
          // ignore
        }
      },
    },
    { type: "separator" },
    {
      label: "Stats",
      submenu: buildStatsSubmenu(),
    },
    { type: "separator" },
    {
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
    },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
}

// ── App lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(() => {
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

  // Auto-setup hooks on launch
  let hooksActive = false;
  try {
    setupHooks();
    hooksActive = true;
  } catch (e) {
    console.error("Could not auto-setup hooks:", e.message);
  }

  createWindow();

  // System tray
  tray = new Tray(path.join(__dirname, "icon.png"));
  tray.setToolTip("Claude Code Pet");
  tray.setContextMenu(buildTrayMenu(hooksActive));

  // Refresh tray menu periodically so stats stay current
  setInterval(() => {
    try { tray.setContextMenu(buildTrayMenu(hooksActive)); } catch (e) { /* ignore */ }
  }, 15000);
});

function writeStatus(s) {
  fs.writeFileSync(STATUS_FILE, s);
}

app.on("before-quit", () => {
  progression.shutdown();
});

app.on("window-all-closed", () => app.quit());
