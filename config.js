// config.js - Settings management for watchers
const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const CONFIG_DIR = path.join(app.getPath("userData"));
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

const DEFAULTS = {
  version: 2,
  skin: "girlfriend",
  petName: "Anu",
  customMessages: [],
  specialDates: [],
  // Sound settings
  soundEnabled: false,
  soundVolume: 0.7,
  // Love meter persistent state
  loveMeter: { points: 0, level: 1 },
  // Spotify integration
  spotify: {
    enabled: false,
    accessToken: null,
    refreshToken: null,
    tokenExpiry: 0,
    clientId: "",
    clientSecret: "",
    showSongChanges: true,
    favoriteArtists: [],
  },
  // Weather settings
  weather: {
    enabled: false,
    latitude: null,
    longitude: null,
    cityName: "",
    showTemperature: true,
    pollIntervalMin: 30,
  },
  // Notification listener (Windows)
  notifications: {
    enabled: false,
    specialPersonName: "Anu",
    showPreview: false,
  },
  // Photo frame
  photos: {
    enabled: false,
    folderPath: null,
    slideshowIntervalSec: 30,
    autoOnSpecialDates: true,
  },
  watchers: {
    idleDetector: { enabled: true, idleThresholdSec: 60 },
    windowTracker: {
      enabled: true,
      processMap: {
        "Code.exe": "coding",
        "chrome.exe": "searching",
        "firefox.exe": "searching",
        "msedge.exe": "searching",
        "Spotify.exe": "idle-dancing",
        "slack.exe": "reading",
        "WhatsApp.exe": "idle",
        "Discord.exe": "reading",
        "Obsidian.exe": "reading",
        "WindowsTerminal.exe": "coding",
        "powershell.exe": "coding",
        "cmd.exe": "coding",
      },
    },
    systemMonitor: { enabled: true, cpuHighThreshold: 80 },
    pomodoro: { enabled: false, workMinutes: 25, breakMinutes: 5 },
    gitWatcher: { enabled: false, repoPath: null },
    buildWatcher: { enabled: false, watchPath: null },
    slack: { enabled: false, token: null, pollIntervalSec: 30 },
  },
};

let _config = null;

function load() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      // Merge with defaults so new keys are always present
      _config = deepMerge(JSON.parse(JSON.stringify(DEFAULTS)), raw);
      _config.version = DEFAULTS.version;
    }
  } catch (e) {
    // corrupt — use defaults
  }
  if (!_config) {
    _config = JSON.parse(JSON.stringify(DEFAULTS));
  }
  return _config;
}

function save() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(_config, null, 2));
  } catch (e) {
    // ignore
  }
}

function get() {
  if (!_config) load();
  return _config;
}

function set(keyPath, value) {
  if (!_config) load();
  const keys = keyPath.split(".");
  let obj = _config;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!obj[keys[i]]) obj[keys[i]] = {};
    obj = obj[keys[i]];
  }
  obj[keys[keys.length - 1]] = value;
  save();
}

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object"
    ) {
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

module.exports = { load, save, get, set, DEFAULTS };
