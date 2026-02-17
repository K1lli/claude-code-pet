// watchers/window-tracker.js - Active window process tracking via PowerShell
const { execFile } = require("child_process");

// PowerShell script to get the foreground window's process name
const PS_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FgWin {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@
$hwnd = [FgWin]::GetForegroundWindow()
$pid = 0
[void][FgWin]::GetWindowThreadProcessId($hwnd, [ref]$pid)
$proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
if ($proc) { $proc.ProcessName + ".exe" } else { "N/A" }
`.trim();

class WindowTracker {
  constructor(config) {
    this.processMap = (config && config.processMap) || {};
    this.pollInterval = null;
    this._currentProcess = null;
    this._currentStatus = null;
  }

  start() {
    this.pollInterval = setInterval(() => this._query(), 5000);
    // Initial query
    setTimeout(() => this._query(), 1000);
  }

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  _query() {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NoLogo", "-ExecutionPolicy", "Bypass", "-Command", PS_SCRIPT],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err) return;
        const procName = (stdout || "").trim();
        if (procName && procName !== "N/A") {
          this._currentProcess = procName;
          this._currentStatus = this.processMap[procName] || null;
        } else {
          this._currentProcess = null;
          this._currentStatus = null;
        }
      }
    );
  }

  getState() {
    if (this._currentStatus) {
      return { status: this._currentStatus };
    }
    return null;
  }

  getCurrentProcess() {
    return this._currentProcess;
  }
}

module.exports = { WindowTracker };
