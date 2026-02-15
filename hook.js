#!/usr/bin/env node
// Claude Code Pet - Hook Handler
// Called automatically by Claude Code hooks to update pet animation state.
// Usage: node hook.js <EventName>
// Receives hook data as JSON on stdin.

const fs = require("fs");
const path = require("path");
const os = require("os");

const appData =
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const STATUS_FILE = path.join(
  appData,
  "claude-code-pet",
  "claude-pet-status.txt"
);

const LOG_FILE = path.join(appData, "claude-code-pet", "hook-debug.log");

// Ensure directory exists
try {
  fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
} catch (e) {
  // ignore
}

function log(msg) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) {}
}

const hookEvent = process.argv[2];
log(`Hook called: ${hookEvent}`);

let input = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let data = {};
  try {
    data = JSON.parse(input);
  } catch (e) {
    log(`JSON parse error: ${e.message}`);
  }

  log(`Tool: ${data.tool_name || "N/A"}, Event: ${hookEvent}`);
  let status = null;

  switch (hookEvent) {
    case "UserPromptSubmit":
      status = "thinking";
      break;

    case "PreToolUse":
      status = classifyTool(data);
      break;

    case "PostToolUseFailure":
      status = "error";
      break;

    case "Stop":
      status = "success";
      break;

    case "Notification":
      status = "thinking";
      break;
  }

  if (status) {
    try {
      fs.writeFileSync(STATUS_FILE, status);
    } catch (e) {
      // ignore write errors - don't block Claude Code
    }
  }
});

// ── Tool Classification ─────────────────────────────────────────────────────
// Maps Claude Code tool usage to granular pet animation keywords.
// Inspects both the tool name and tool_input for context-aware detection.

function classifyTool(data) {
  const tool = data.tool_name || "";
  const input = data.tool_input || {};

  // Bash commands - inspect the command string for specific actions
  if (tool === "Bash") {
    const cmd = (input.command || "").toLowerCase();
    const desc = (input.description || "").toLowerCase();
    const text = cmd + " " + desc;

    if (
      text.includes("npm install") ||
      text.includes("yarn add") ||
      text.includes("pip install") ||
      text.includes("apt install") ||
      text.includes("brew install") ||
      text.includes("cargo add") ||
      text.includes("pnpm add") ||
      text.includes("bun add")
    )
      return "installing";

    if (
      text.includes("npm test") ||
      text.includes("pytest") ||
      text.includes("jest") ||
      text.includes("vitest") ||
      text.includes("mocha") ||
      text.includes("cargo test") ||
      text.includes("go test") ||
      text.includes("unittest") ||
      text.includes("run test")
    )
      return "testing";

    if (
      text.includes("deploy") ||
      text.includes("publish") ||
      text.includes("push") ||
      text.includes("release") ||
      text.includes("ship")
    )
      return "deploying";

    if (
      text.includes("download") ||
      text.includes("curl") ||
      text.includes("wget") ||
      text.includes("fetch") ||
      text.includes("clone")
    )
      return "downloading";

    if (
      text.includes("rm ") ||
      text.includes("del ") ||
      text.includes("remove") ||
      text.includes("clean") ||
      text.includes("uninstall") ||
      text.includes("prune")
    )
      return "deleting";

    if (text.includes("debug") || text.includes("inspect"))
      return "debugging";

    if (
      text.includes("build") ||
      text.includes("compile") ||
      text.includes("make") ||
      text.includes("bundle") ||
      text.includes("cook")
    )
      return "cooking";

    // Generic bash → coding
    return "coding";
  }

  // Search/exploration tools
  if (tool === "Grep" || tool === "WebSearch") return "searching";
  if (tool === "Glob") return "searching";

  // Reading tools
  if (tool === "Read" || tool === "WebFetch") return "reading";

  // Writing/editing tools
  if (tool === "Write" || tool === "Edit" || tool === "NotebookEdit")
    return "coding";

  // Task delegation
  if (tool === "Task") {
    const subtype = (input.subagent_type || "").toLowerCase();
    if (subtype === "explore") return "searching";
    if (subtype === "plan") return "thinking";
    return "thinking";
  }

  // Default for unknown tools
  return "thinking";
}
