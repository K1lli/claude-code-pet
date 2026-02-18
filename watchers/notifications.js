// watchers/notifications.js - Windows toast notification listener
// Reads Windows Notification Center history to detect WhatsApp messages
// and identify the sender name — reacts specially for the configured person.

const { exec } = require("child_process");

class NotificationWatcher {
  constructor(config, onNotification) {
    this.enabled = config.enabled || false;
    this.specialPersonName = config.specialPersonName || "";
    this.showPreview = config.showPreview || false;
    this.onNotification = onNotification;
    this.timer = null;
    this._state = null;
    this.lastNotifTimestamp = 0; // track latest seen notification
    this.consecutiveCount = 0;
    this.lastReactTime = 0;
  }

  start() {
    if (process.platform !== "win32") {
      console.log("[Notifications] Only supported on Windows");
      return;
    }
    console.log("[Notifications] Started — watching for WhatsApp messages" +
      (this.specialPersonName ? ` (special: ${this.specialPersonName})` : ""));
    // Poll every 5 seconds
    this.timer = setInterval(() => this._checkNotifications(), 5000);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  setSpecialPerson(name) {
    this.specialPersonName = name;
    console.log("[Notifications] Special person set to:", name);
  }

  getState() {
    return this._state;
  }

  _checkNotifications() {
    // PowerShell script that reads Windows notification history
    // via the UserNotificationListener API (Windows 10/11).
    // Filters for WhatsApp notifications and extracts sender + preview.
    const psScript = `
[Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null

$listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
$access = $listener.RequestAccessAsync().GetAwaiter().GetResult()

if ($access -ne 'Allowed') {
  Write-Output "NOACCESS"
  exit
}

$notifications = $listener.GetNotificationsAsync(
  [Windows.UI.Notifications.NotificationKinds]::Toast
).GetAwaiter().GetResult()

foreach ($n in $notifications) {
  try {
    $appInfo = $n.AppInfo
    $appName = ""
    if ($appInfo) { $appName = $appInfo.DisplayInfo.DisplayName }

    # Filter: only WhatsApp
    if ($appName -notlike "*WhatsApp*") { continue }

    $binding = $n.Notification.Visual.GetBinding(
      [Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric
    )
    if (-not $binding) { continue }

    $texts = $binding.GetTextElements()
    $sender = ""
    $preview = ""
    $idx = 0
    foreach ($t in $texts) {
      if ($idx -eq 0) { $sender = $t.Text }
      elseif ($idx -eq 1) { $preview = $t.Text }
      $idx++
    }

    $ts = $n.CreationTime.ToUnixTimeMilliseconds()
    Write-Output "MSG|$ts|$sender|$preview"
  } catch {
    # skip malformed notification
  }
}
`;

    exec(
      `powershell.exe -NoProfile -NonInteractive -Command "${psScript.replace(/"/g, '\\"')}"`,
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          // Fallback: try simpler window-title approach
          this._checkFallback();
          return;
        }
        const output = (stdout || "").trim();

        if (output === "NOACCESS") {
          // Notification access not granted — fall back
          this._checkFallback();
          return;
        }

        // Parse MSG lines, find newest WhatsApp notifications
        const lines = output.split(/\r?\n/).filter(l => l.startsWith("MSG|"));
        if (lines.length === 0) {
          this.consecutiveCount = 0;
          return;
        }

        // Find notifications newer than what we last saw
        let newMessages = [];
        for (const line of lines) {
          const parts = line.split("|");
          if (parts.length < 4) continue;
          const ts = parseInt(parts[1], 10);
          const sender = parts[2];
          const preview = parts.slice(3).join("|");
          if (ts > this.lastNotifTimestamp) {
            newMessages.push({ ts, sender, preview });
          }
        }

        if (newMessages.length === 0) return;

        // Update last seen timestamp
        newMessages.sort((a, b) => b.ts - a.ts);
        this.lastNotifTimestamp = newMessages[0].ts;

        // Throttle: don't react more than once per 15 seconds
        if (Date.now() - this.lastReactTime < 15000) return;
        this.lastReactTime = Date.now();

        // Check if special person sent a message
        const specialMsg = newMessages.find(m =>
          this.specialPersonName &&
          m.sender.toLowerCase().includes(this.specialPersonName.toLowerCase())
        );

        if (specialMsg) {
          // Special person message!
          this.consecutiveCount++;
          if (this.onNotification) {
            this.onNotification({
              sender: specialMsg.sender,
              isSpecial: true,
              preview: this.showPreview ? specialMsg.preview : null,
              count: newMessages.filter(m =>
                m.sender.toLowerCase().includes(this.specialPersonName.toLowerCase())
              ).length,
            });
          }
        } else if (newMessages.length > 0) {
          // Other people's messages — less exciting
          if (this.onNotification) {
            this.onNotification({
              sender: newMessages[0].sender,
              isSpecial: false,
              preview: this.showPreview ? newMessages[0].preview : null,
              count: newMessages.length,
            });
          }
        }
      }
    );
  }

  // Fallback: read WhatsApp window title for unread count
  // (used when notification listener access is not available)
  _checkFallback() {
    const psSimple = `
try {
  $w = Get-Process -Name "WhatsApp" -ErrorAction SilentlyContinue | Select-Object MainWindowTitle
  if ($w -and $w.MainWindowTitle -match '\\((\\d+)\\)') {
    Write-Output "UNREAD:$($Matches[1]):$($w.MainWindowTitle)"
  }
} catch {}
`;
    exec(
      `powershell.exe -NoProfile -NonInteractive -Command "${psSimple.replace(/"/g, '\\"')}"`,
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err) return;
        const output = (stdout || "").trim();

        if (output.startsWith("UNREAD:")) {
          const parts = output.split(":");
          const count = parseInt(parts[1], 10);
          const title = parts.slice(2).join(":");

          if (count > 0 && Date.now() - this.lastReactTime > 30000) {
            this.lastReactTime = Date.now();

            // Check if the window title contains the special person name
            const isSpecial = this.specialPersonName &&
              title.toLowerCase().includes(this.specialPersonName.toLowerCase());

            if (this.onNotification) {
              this.onNotification({
                sender: isSpecial ? this.specialPersonName : null,
                isSpecial: isSpecial,
                preview: null,
                count: count,
              });
            }
          }
        }
      }
    );
  }
}

module.exports = { NotificationWatcher };
