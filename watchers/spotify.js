// watchers/spotify.js - Spotify integration with OAuth
const http = require("http");

class SpotifyWatcher {
  constructor(config, petConfig, onTrackChange) {
    this.clientId = config.clientId || "";
    this.clientSecret = config.clientSecret || "";
    this.accessToken = config.accessToken || null;
    this.refreshToken = config.refreshToken || null;
    this.tokenExpiry = config.tokenExpiry || 0;
    this.showSongChanges = config.showSongChanges !== false;
    this.favoriteArtists = config.favoriteArtists || [];
    this.petConfig = petConfig;
    this.onTrackChange = onTrackChange;
    this.timer = null;
    this.lastTrackId = null;
    this.currentTrack = null;
    this._state = null;
    this.callbackServer = null;
    this.SpotifyApi = null;
    this.spotifyApi = null;
  }

  start() {
    try {
      this.SpotifyApi = require("spotify-web-api-node");
      this.spotifyApi = new this.SpotifyApi({
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        redirectUri: "http://localhost:8765/callback",
      });

      if (this.refreshToken) {
        this.spotifyApi.setRefreshToken(this.refreshToken);
        this._refreshAndPoll();
      } else if (this.clientId && this.clientSecret) {
        this._startOAuthFlow();
      }
    } catch (e) {
      console.error("[Spotify] spotify-web-api-node not available:", e.message);
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.callbackServer) {
      try { this.callbackServer.close(); } catch (e) {}
      this.callbackServer = null;
    }
  }

  isConnected() {
    return !!this.accessToken && Date.now() < this.tokenExpiry;
  }

  getCurrentTrack() {
    return this.currentTrack;
  }

  getState() {
    return this._state;
  }

  _startOAuthFlow() {
    const scopes = ["user-read-currently-playing", "user-read-playback-state"];
    const authorizeURL = this.spotifyApi.createAuthorizeURL(scopes, "pet-state");

    // Start local callback server
    this.callbackServer = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost:8765");
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        if (code) {
          this._exchangeCode(code);
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<html><body style='font-family:Segoe UI;text-align:center;padding:40px;background:#1e1e2e;color:#cdd6f4'><h2>Connected to Spotify! 🎵</h2><p>You can close this window.</p><script>setTimeout(()=>window.close(),2000)</script></body></html>");
        } else {
          res.writeHead(400);
          res.end("No authorization code received.");
        }
        // Close server after handling
        setTimeout(() => {
          if (this.callbackServer) {
            try { this.callbackServer.close(); } catch (e) {}
            this.callbackServer = null;
          }
        }, 3000);
      }
    });

    this.callbackServer.listen(8765, () => {
      console.log("[Spotify] OAuth callback server on port 8765");
      // Open browser for auth
      const { shell } = require("electron");
      shell.openExternal(authorizeURL);
    });

    this.callbackServer.on("error", (e) => {
      console.error("[Spotify] Callback server error:", e.message);
    });
  }

  async _exchangeCode(code) {
    try {
      const data = await this.spotifyApi.authorizationCodeGrant(code);
      this.accessToken = data.body.access_token;
      this.refreshToken = data.body.refresh_token;
      this.tokenExpiry = Date.now() + data.body.expires_in * 1000;

      this.spotifyApi.setAccessToken(this.accessToken);
      this.spotifyApi.setRefreshToken(this.refreshToken);

      // Persist tokens
      if (this.petConfig) {
        this.petConfig.set("spotify.accessToken", this.accessToken);
        this.petConfig.set("spotify.refreshToken", this.refreshToken);
        this.petConfig.set("spotify.tokenExpiry", this.tokenExpiry);
        this.petConfig.set("spotify.enabled", true);
      }

      console.log("[Spotify] Authenticated successfully");
      this._startPolling();
    } catch (e) {
      console.error("[Spotify] Token exchange failed:", e.message);
    }
  }

  async _refreshAndPoll() {
    try {
      const data = await this.spotifyApi.refreshAccessToken();
      this.accessToken = data.body.access_token;
      this.tokenExpiry = Date.now() + data.body.expires_in * 1000;
      this.spotifyApi.setAccessToken(this.accessToken);

      if (this.petConfig) {
        this.petConfig.set("spotify.accessToken", this.accessToken);
        this.petConfig.set("spotify.tokenExpiry", this.tokenExpiry);
      }

      console.log("[Spotify] Token refreshed");
      this._startPolling();
    } catch (e) {
      console.error("[Spotify] Refresh failed:", e.message);
    }
  }

  _startPolling() {
    this.timer = setInterval(() => this._poll(), 7000); // Poll every 7s
    this._poll(); // Immediate first poll
  }

  async _poll() {
    // Refresh token if near expiry
    if (Date.now() > this.tokenExpiry - 60000) {
      try {
        const data = await this.spotifyApi.refreshAccessToken();
        this.accessToken = data.body.access_token;
        this.tokenExpiry = Date.now() + data.body.expires_in * 1000;
        this.spotifyApi.setAccessToken(this.accessToken);
        if (this.petConfig) {
          this.petConfig.set("spotify.accessToken", this.accessToken);
          this.petConfig.set("spotify.tokenExpiry", this.tokenExpiry);
        }
      } catch (e) {
        console.error("[Spotify] Refresh error:", e.message);
        return;
      }
    }

    try {
      const data = await this.spotifyApi.getMyCurrentPlayingTrack();
      if (data.body && data.body.item) {
        const track = data.body.item;
        const trackId = track.id;
        const artist = track.artists.map(a => a.name).join(", ");
        const isPlaying = data.body.is_playing;

        this.currentTrack = {
          name: track.name,
          artist: artist,
          id: trackId,
          isPlaying: isPlaying,
        };

        // Detect track change
        if (trackId !== this.lastTrackId && this.showSongChanges) {
          this.lastTrackId = trackId;
          const isFavorite = this.favoriteArtists.some(
            fa => artist.toLowerCase().includes(fa.toLowerCase())
          );

          if (this.onTrackChange) {
            this.onTrackChange({
              playing: isPlaying,
              name: track.name,
              artist: artist,
              isFavorite: isFavorite,
            });
          }
        }

        // Detect play/pause toggle
        if (!isPlaying && this.lastTrackId === trackId) {
          this._state = { status: "idle" };
        } else {
          this._state = { status: "idle" }; // Don't override main status
        }
      } else {
        this.currentTrack = null;
        this._state = null;
      }
    } catch (e) {
      // 401 = need refresh, 204 = nothing playing
      if (e.statusCode === 401) {
        this._refreshAndPoll();
      }
    }
  }
}

module.exports = { SpotifyWatcher };
