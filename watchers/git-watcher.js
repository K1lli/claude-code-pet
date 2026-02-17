// watchers/git-watcher.js - Git repository state monitoring
const { execFile } = require("child_process");

class GitWatcher {
  constructor(config) {
    this.repoPath = (config && config.repoPath) || null;
    this.pollInterval = null;
    this._lastCommit = null;
    this._state = null;
    this._newCommitMsg = null;
  }

  start() {
    if (!this.repoPath) return;
    this._poll();
    this.pollInterval = setInterval(() => this._poll(), 15000);
  }

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  setRepoPath(repoPath) {
    this.repoPath = repoPath;
    this._lastCommit = null;
    this._state = null;
    this._newCommitMsg = null;
    // Restart polling
    this.stop();
    if (repoPath) this.start();
  }

  _poll() {
    if (!this.repoPath) return;

    // Get current HEAD commit
    this._exec(["rev-parse", "HEAD"], (err, head) => {
      if (err) {
        this._state = null;
        return;
      }
      head = head.trim();

      // Check for new commit
      if (this._lastCommit && head !== this._lastCommit) {
        // Get commit message
        this._exec(["log", "-1", "--pretty=%s", head], (err2, msg) => {
          if (!err2) {
            this._newCommitMsg = msg.trim();
          }
        });
      }
      this._lastCommit = head;
    });

    // Check git status
    this._exec(["status", "--porcelain"], (err, output) => {
      if (err) {
        this._state = null;
        return;
      }
      const lines = output.trim().split("\n").filter(Boolean);

      // Check for merge conflicts (lines starting with UU, AA, etc.)
      const hasConflict = lines.some(
        (l) => l.startsWith("UU") || l.startsWith("AA") || l.startsWith("DD")
      );

      if (hasConflict) {
        this._state = { status: "error", message: "Merge conflict detected!" };
      } else if (this._newCommitMsg) {
        const msg = this._newCommitMsg;
        this._newCommitMsg = null;
        this._state = { status: "success", message: `Commit: ${msg}` };
      } else if (lines.length > 0) {
        this._state = { status: "coding" };
      } else {
        this._state = null;
      }
    });
  }

  _exec(args, cb) {
    execFile("git", args, { cwd: this.repoPath, timeout: 10000 }, (err, stdout) => {
      cb(err, stdout || "");
    });
  }

  getState() {
    return this._state;
  }

  getBranch(cb) {
    if (!this.repoPath) return cb(null, null);
    this._exec(["branch", "--show-current"], (err, branch) => {
      cb(err, branch ? branch.trim() : null);
    });
  }

  getChangedCount(cb) {
    if (!this.repoPath) return cb(null, 0);
    this._exec(["status", "--porcelain"], (err, output) => {
      if (err) return cb(err, 0);
      const count = output.trim().split("\n").filter(Boolean).length;
      cb(null, count);
    });
  }
}

module.exports = { GitWatcher };
