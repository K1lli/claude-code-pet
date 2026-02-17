// watchers/slack.js - Slack message polling via Node.js https module
const https = require("https");

class SlackWatcher {
  constructor(config) {
    this.token = (config && config.token) || null;
    this.pollIntervalSec = (config && config.pollIntervalSec) || 30;
    this.showMessages = true;
    this.pollTimer = null;
    this._lastTs = null;
    this._latestMessage = null;
    this._connected = false;
    this._channelId = null; // auto-detected from conversations.list
  }

  start() {
    if (!this.token) return;
    this._findChannel();
    this.pollTimer = setInterval(() => this._poll(), this.pollIntervalSec * 1000);
  }

  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  setToken(token) {
    this.stop();
    this.token = token;
    this._lastTs = null;
    this._latestMessage = null;
    this._connected = false;
    this._channelId = null;
    if (token) this.start();
  }

  _apiCall(method, params, cb) {
    const url = new URL(`https://slack.com/api/${method}`);
    for (const [k, v] of Object.entries(params)) {
      if (v != null) url.searchParams.set(k, v);
    }

    const req = https.get(
      url.toString(),
      {
        headers: { Authorization: `Bearer ${this.token}` },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            cb(null, JSON.parse(data));
          } catch (e) {
            cb(e, null);
          }
        });
      }
    );
    req.on("error", (e) => cb(e, null));
    req.setTimeout(10000, () => {
      req.destroy();
      cb(new Error("timeout"), null);
    });
  }

  _findChannel() {
    // Find the most recent DM channel to watch
    this._apiCall("conversations.list", { types: "im", limit: "1" }, (err, data) => {
      if (!err && data && data.ok && data.channels && data.channels.length > 0) {
        this._channelId = data.channels[0].id;
        this._connected = true;
        // Initial poll
        this._poll();
      } else {
        // Try general channel
        this._apiCall("conversations.list", { types: "public_channel", limit: "5" }, (err2, data2) => {
          if (!err2 && data2 && data2.ok && data2.channels) {
            const general = data2.channels.find((c) => c.name === "general");
            if (general) {
              this._channelId = general.id;
              this._connected = true;
              this._poll();
            }
          }
        });
      }
    });
  }

  _poll() {
    if (!this.token || !this._channelId) return;

    const params = { channel: this._channelId, limit: "1" };
    if (this._lastTs) {
      params.oldest = this._lastTs;
    }

    this._apiCall("conversations.history", params, (err, data) => {
      if (err || !data || !data.ok) {
        this._connected = false;
        return;
      }
      this._connected = true;

      if (data.messages && data.messages.length > 0) {
        const msg = data.messages[0];
        if (this._lastTs && msg.ts !== this._lastTs) {
          // New message!
          const text = (msg.text || "").slice(0, 100);
          if (text && this.showMessages) {
            this._latestMessage = text;
            // Clear after 8 seconds
            setTimeout(() => {
              this._latestMessage = null;
            }, 8000);
          }
        }
        this._lastTs = msg.ts;
      }
    });
  }

  getState() {
    if (this._latestMessage) {
      const msg = this._latestMessage;
      this._latestMessage = null;
      return { status: "reading", message: msg, duration: 8000 };
    }
    return null;
  }

  isConnected() {
    return this._connected;
  }
}

module.exports = { SlackWatcher };
