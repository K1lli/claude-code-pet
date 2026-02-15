// set-status.js - Helper to change pet state from terminal / scripts
// Usage: node set-status.js thinking
//        node set-status.js coding
//        node set-status.js success

const fs = require("fs");
const path = require("path");

// Match the path Electron uses for userData
const appData = process.env.APPDATA || path.join(require("os").homedir(), "AppData", "Roaming");
const statusFile = path.join(appData, "claude-code-pet", "claude-pet-status.txt");

const status = process.argv[2] || "idle";
const valid = ["idle", "thinking", "coding", "success", "error"];

if (!valid.includes(status)) {
  console.log(`Usage: node set-status.js [${valid.join("|")}]`);
  process.exit(1);
}

// Ensure directory exists
fs.mkdirSync(path.dirname(statusFile), { recursive: true });
fs.writeFileSync(statusFile, status);
console.log(`Pet status set to: ${status}`);
console.log(`Status file: ${statusFile}`);
