// watcher.js - Wrap your Claude Code session and auto-detect states
// Usage: node watcher.js
//
// This watches Claude Code's stdout/stderr and updates the pet status.
// Run this INSTEAD of claude directly, or pipe claude's output through it.
//
// Option A: node watcher.js  (runs claude code as child process)
// Option B: claude 2>&1 | node watcher.js --pipe

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const appData = process.env.APPDATA || path.join(require("os").homedir(), "AppData", "Roaming");
const statusFile = path.join(appData, "claude-code-pet", "claude-pet-status.txt");
fs.mkdirSync(path.dirname(statusFile), { recursive: true });

let idleTimer = null;

function setStatus(s) {
  fs.writeFileSync(statusFile, s);
  // Auto-return to idle after success/error
  clearTimeout(idleTimer);
  if (s === "success" || s === "error") {
    idleTimer = setTimeout(() => fs.writeFileSync(statusFile, "idle"), 4000);
  }
}

function classify(text) {
  const t = text.toLowerCase();
  // Adjust these patterns based on your Claude Code version's output
  if (t.includes("thinking") || t.includes("analyzing") || t.includes("reading")) return "thinking";
  if (t.includes("writing") || t.includes("editing") || t.includes("creating") || t.includes("updating")) return "coding";
  if (t.includes("done") || t.includes("complete") || t.includes("success") || t.includes("finished")) return "success";
  if (t.includes("error") || t.includes("failed") || t.includes("exception") || t.includes("traceback")) return "error";
  if (t.includes("running") || t.includes("executing") || t.includes("installing")) return "coding";
  return null; // no change
}

if (process.argv.includes("--pipe")) {
  // Pipe mode: claude 2>&1 | node watcher.js --pipe
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => {
    process.stdout.write(chunk); // pass through
    const s = classify(chunk);
    if (s) setStatus(s);
  });
  process.stdin.on("end", () => setStatus("idle"));
} else {
  // Spawn mode: wraps claude code
  console.log("Starting Claude Code with pet watcher...");
  setStatus("idle");

  const child = spawn("claude", process.argv.slice(2), {
    stdio: ["inherit", "pipe", "pipe"],
    shell: true,
  });

  child.stdout.on("data", (d) => {
    const text = d.toString();
    process.stdout.write(text);
    const s = classify(text);
    if (s) setStatus(s);
  });

  child.stderr.on("data", (d) => {
    const text = d.toString();
    process.stderr.write(text);
    const s = classify(text);
    if (s) setStatus(s);
  });

  child.on("close", (code) => {
    setStatus(code === 0 ? "success" : "error");
    setTimeout(() => setStatus("idle"), 5000);
  });
}
