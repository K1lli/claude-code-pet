// main.js - Electron main process
const { app, BrowserWindow, Tray, Menu, screen, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Status file that controls the pet's state
const STATUS_FILE = path.join(
  app.getPath("userData"),
  "claude-pet-status.txt"
);

// Ensure status file exists
if (!fs.existsSync(STATUS_FILE)) fs.writeFileSync(STATUS_FILE, "idle");

let win, tray;
let currentStatus = "idle";
let lastChangeTime = Date.now();

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

    // Build our hook entry
    const entry = {
      hooks: [
        {
          type: "command",
          command: `node "${hookPath}" ${name}`,
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
      }
    } catch (e) {
      // ignore
    }
  });

  // Poll every second as backup + handle auto-idle revert
  setInterval(() => {
    try {
      const status = fs.readFileSync(STATUS_FILE, "utf-8").trim();

      if (status !== currentStatus) {
        currentStatus = status;
        lastChangeTime = Date.now();
        win.webContents.send("status-change", status);
      }

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
});

function writeStatus(s) {
  fs.writeFileSync(STATUS_FILE, s);
}

app.on("window-all-closed", () => app.quit());
