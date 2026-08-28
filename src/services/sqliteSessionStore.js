const session = require('express-session');
const { db } = require('../db');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Persistent express-session store backed by the application's existing
 * better-sqlite3 connection. This avoids a second sqlite native dependency.
 */
class SQLiteSessionStore extends session.Store {
  constructor({ ttlMs = DEFAULT_TTL_MS } = {}) {
    super();
    this.ttlMs = ttlMs;

    db.exec(`
      CREATE TABLE IF NOT EXISTS web_sessions (
        sid TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        session_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_web_sessions_expiry ON web_sessions(expires_at);
    `);

    this.getById = db.prepare('SELECT session_json, expires_at FROM web_sessions WHERE sid = ?');
    this.upsert = db.prepare(`
      INSERT INTO web_sessions (sid, expires_at, session_json)
      VALUES (@sid, @expires_at, @session_json)
      ON CONFLICT(sid) DO UPDATE SET
        expires_at = excluded.expires_at,
        session_json = excluded.session_json
    `);
    this.updateExpiry = db.prepare('UPDATE web_sessions SET expires_at = ? WHERE sid = ?');
    this.deleteById = db.prepare('DELETE FROM web_sessions WHERE sid = ?');
    this.deleteExpired = db.prepare('DELETE FROM web_sessions WHERE expires_at <= ?');

    this.deleteExpired.run(Date.now());
  }

  get(sid, callback) {
    try {
      const row = this.getById.get(sid);
      if (!row) return callback(null, null);
      if (row.expires_at <= Date.now()) {
        this.deleteById.run(sid);
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.session_json));
    } catch (error) {
      return callback(error);
    }
  }

  set(sid, sessionData, callback = () => {}) {
    try {
      const maxAge = Number(sessionData?.cookie?.maxAge);
      const expiresAt = Date.now() + (Number.isFinite(maxAge) && maxAge > 0 ? maxAge : this.ttlMs);
      this.upsert.run({ sid, expires_at: expiresAt, session_json: JSON.stringify(sessionData) });
      this.deleteExpired.run(Date.now());
      return callback(null);
    } catch (error) {
      return callback(error);
    }
  }

  touch(sid, sessionData, callback = () => {}) {
    try {
      const maxAge = Number(sessionData?.cookie?.maxAge);
      const expiresAt = Date.now() + (Number.isFinite(maxAge) && maxAge > 0 ? maxAge : this.ttlMs);
      const result = this.updateExpiry.run(expiresAt, sid);
      if (!result.changes) return this.set(sid, sessionData, callback);
      return callback(null);
    } catch (error) {
      return callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.deleteById.run(sid);
      return callback(null);
    } catch (error) {
      return callback(error);
    }
  }
}

module.exports = SQLiteSessionStore;
