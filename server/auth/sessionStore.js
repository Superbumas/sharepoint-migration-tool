const crypto = require('node:crypto');
const session = require('express-session');
const { getDb } = require('../db');
const { encrypt, decrypt } = require('../util/secretCrypto');

// SQLite-backed express-session store, so a server restart no longer signs
// everyone out (the in-memory default lost every session on restart).
//
// Each session holds the user's MSAL token cache - a refresh token for their
// tenant - so the row is encrypted at rest. The key is derived from
// SESSION_SECRET, which already protects the session cookie: if it changes,
// old cookies are invalid anyway, and rows that no longer decrypt are simply
// treated as "no session" (the user signs in again, nothing breaks).
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 15 * 60 * 1000;

class SqliteSessionStore extends session.Store {
  constructor({ secret }) {
    super();
    this.key = crypto.createHash('sha256').update(`session-store:${secret}`).digest('base64');
    const timer = setInterval(() => this.prune(), PRUNE_EVERY_MS);
    timer.unref();
  }

  expiryOf(sess) {
    const exp = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : NaN;
    return Number.isFinite(exp) ? exp : Date.now() + DEFAULT_TTL_MS;
  }

  get(sid, cb) {
    try {
      const row = getDb().prepare('SELECT data, expires_at FROM sessions WHERE sid = ?').get(sid);
      if (!row) return cb(null, null);
      if (row.expires_at <= Date.now()) {
        this.destroy(sid, () => {});
        return cb(null, null);
      }
      let sess;
      try {
        sess = JSON.parse(decrypt(row.data, this.key));
      } catch {
        return cb(null, null); // SESSION_SECRET changed - just "signed out"
      }
      cb(null, sess);
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb = () => {}) {
    try {
      getDb().prepare(
        `INSERT INTO sessions (sid, expires_at, data) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET expires_at = excluded.expires_at, data = excluded.data`
      ).run(sid, this.expiryOf(sess), encrypt(JSON.stringify(sess), this.key));
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  touch(sid, sess, cb = () => {}) {
    try {
      getDb().prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?').run(this.expiryOf(sess), sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  destroy(sid, cb = () => {}) {
    try {
      getDb().prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  prune() {
    try {
      getDb().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    } catch (err) {
      console.error('[session] prune failed:', err.message);
    }
  }
}

module.exports = { SqliteSessionStore };
