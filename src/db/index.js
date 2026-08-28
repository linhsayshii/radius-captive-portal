const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { loadConfig } = require('../config');

const config = loadConfig();
const dbPath = config.databasePath || './data/wifi-portal.db';

// Ensure data directory exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// Lightweight forward migrations
db.exec(`
  CREATE TABLE IF NOT EXISTS mac_authorizations (
    mac_address TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    username TEXT,
    access_type TEXT NOT NULL,
    connected_at DATETIME NOT NULL,
    expires_at DATETIME NOT NULL,
    ip_address TEXT,
    user_agent TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_mac_authorizations_expiry ON mac_authorizations(expires_at);
`);

try {
  db.exec(`ALTER TABLE users ADD COLUMN package_id INTEGER REFERENCES packages(id);`);
} catch (_) {}

// User queries
const userQueries = {
  getById: db.prepare('SELECT u.*, p.name as package_name FROM users u LEFT JOIN packages p ON u.package_id = p.id WHERE u.id = ?'),
  getByIdentifier: db.prepare('SELECT u.*, p.name as package_name FROM users u LEFT JOIN packages p ON u.package_id = p.id WHERE u.identifier = ?'),
  getByEmail: db.prepare('SELECT u.*, p.name as package_name FROM users u LEFT JOIN packages p ON u.package_id = p.id WHERE u.email = ?'),
  getAll: db.prepare(`
    SELECT u.*, p.name as package_name, p.bandwidth_down_kbps, p.bandwidth_up_kbps, p.duration_minutes
    FROM users u LEFT JOIN packages p ON u.package_id = p.id
    ORDER BY u.created_at DESC
  `),
  create: db.prepare(`
    INSERT INTO users (type, identifier, email, password_hash, display_name, max_devices, package_id)
    VALUES (@type, @identifier, @email, @password_hash, @display_name, @max_devices, @package_id)
  `),
  update: db.prepare(`
    UPDATE users SET email = @email, display_name = @display_name,
    max_devices = @max_devices, is_active = @is_active, package_id = @package_id
    WHERE id = @id
  `),
  delete: db.prepare('DELETE FROM users WHERE id = ?'),
};

// Package queries
const packageQueries = {
  getById: db.prepare('SELECT * FROM packages WHERE id = ?'),
  getActive: db.prepare('SELECT * FROM packages WHERE is_active = 1 ORDER BY name'),
  create: db.prepare(`
    INSERT INTO packages (name, duration_minutes, quota_mb, bandwidth_down_kbps,
      bandwidth_up_kbps, max_devices, created_by)
    VALUES (@name, @duration_minutes, @quota_mb, @bandwidth_down_kbps,
      @bandwidth_up_kbps, @max_devices, @created_by)
  `),
  update: db.prepare(`
    UPDATE packages SET name = @name, duration_minutes = @duration_minutes,
    quota_mb = @quota_mb, bandwidth_down_kbps = @bandwidth_down_kbps,
    bandwidth_up_kbps = @bandwidth_up_kbps, max_devices = @max_devices,
    is_active = @is_active WHERE id = @id
  `),
  delete: db.prepare('DELETE FROM packages WHERE id = ?'),
};

// Session queries
const sessionQueries = {
  getById: db.prepare('SELECT * FROM sessions WHERE id = ?'),
  getBySessionId: db.prepare('SELECT * FROM sessions WHERE session_id = ?'),
  getActive: db.prepare(`
    SELECT s.*, u.type as user_type, u.display_name, u.email
    FROM sessions s LEFT JOIN users u ON s.user_id = u.id
    WHERE s.is_active = 1 ORDER BY s.start_time DESC
  `),
  getActiveByMac: db.prepare(`
    SELECT * FROM sessions WHERE (mac_address = ? OR username = ?) AND is_active = 1 LIMIT 1
  `),
  create: db.prepare(`
    INSERT INTO sessions (user_id, package_id, mac_address, ip_address,
      nas_identifier, username, session_id, quota_total_mb,
      bandwidth_down_kbps, bandwidth_up_kbps)
    VALUES (@user_id, @package_id, @mac_address, @ip_address,
      @nas_identifier, @username, @session_id, @quota_total_mb,
      @bandwidth_down_kbps, @bandwidth_up_kbps)
  `),
  update: db.prepare(`
    UPDATE sessions SET last_activity = @last_activity, idle_seconds = @idle_seconds,
    quota_used_mb = @quota_used_mb, is_active = @is_active,
    terminated_by = @terminated_by, end_time = @end_time
    WHERE id = @id
  `),
  endAllForUser: db.prepare(`
    UPDATE sessions SET is_active = 0, terminated_by = 'user', end_time = CURRENT_TIMESTAMP
    WHERE user_id = ? AND is_active = 1
  `),
};

// Device queries
const deviceQueries = {
  getByMac: db.prepare('SELECT * FROM devices WHERE mac_address = ?'),
  getByUser: db.prepare('SELECT * FROM devices WHERE user_id = ?'),
  getOnlineByUser: db.prepare('SELECT * FROM devices WHERE user_id = ? AND is_online = 1'),
  create: db.prepare(`
    INSERT INTO devices (user_id, mac_address, device_name, session_id)
    VALUES (@user_id, @mac_address, @device_name, @session_id)
  `),
  updateOnline: db.prepare(`
    UPDATE devices SET is_online = @is_online, last_seen = CURRENT_TIMESTAMP,
    session_id = @session_id WHERE mac_address = @mac_address
  `),
  updateConnection: db.prepare(`
    UPDATE devices SET
      user_id = CASE WHEN @user_id IS NULL THEN user_id ELSE @user_id END,
      is_online = @is_online,
      last_seen = CURRENT_TIMESTAMP,
      session_id = @session_id
    WHERE mac_address = @mac_address
  `),
  setOffline: db.prepare(`
    UPDATE devices SET is_online = 0 WHERE mac_address = ?
  `),
};

// Admin queries
const adminQueries = {
  getByUsername: db.prepare('SELECT * FROM admins WHERE username = ?'),
  getById: db.prepare('SELECT * FROM admins WHERE id = ?'),
  create: db.prepare(`
    INSERT INTO admins (username, password_hash) VALUES (@username, @password_hash)
  `),
  updateLastLogin: db.prepare('UPDATE admins SET last_login = CURRENT_TIMESTAMP WHERE id = ?'),
};

// OAuth whitelist
const oauthQueries = {
  getByEmail: db.prepare('SELECT * FROM oauth_whitelist WHERE google_email = ?'),
  getByUser: db.prepare('SELECT * FROM oauth_whitelist WHERE user_id = ?'),
  create: db.prepare(`
    INSERT INTO oauth_whitelist (user_id, google_email, allowed_by)
    VALUES (@user_id, @google_email, @allowed_by)
  `),
  delete: db.prepare('DELETE FROM oauth_whitelist WHERE id = ?'),
};

// Settings
const settingQueries = {
  get: db.prepare('SELECT value FROM settings WHERE key = ?'),
  set: db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'),
  getAll: db.prepare('SELECT * FROM settings'),
};

// Logs
const logQueries = {
  create: db.prepare(`
    INSERT INTO connection_logs (user_id, session_id, mac_address, ip_address,
      action, nas_identifier, details)
    VALUES (@user_id, @session_id, @mac_address, @ip_address,
      @action, @nas_identifier, @details)
  `),
  getRecent: db.prepare(`
    SELECT * FROM connection_logs ORDER BY timestamp DESC LIMIT ?
  `),
};

const macAuthorizationQueries = {
  upsert: db.prepare(`
    INSERT INTO mac_authorizations (mac_address, user_id, username, access_type, connected_at, expires_at, ip_address, user_agent)
    VALUES (@mac_address, @user_id, @username, @access_type, @connected_at, @expires_at, @ip_address, @user_agent)
    ON CONFLICT(mac_address) DO UPDATE SET
      user_id = excluded.user_id, username = excluded.username, access_type = excluded.access_type,
      connected_at = excluded.connected_at, expires_at = excluded.expires_at,
      ip_address = excluded.ip_address, user_agent = excluded.user_agent
  `),
  get: db.prepare('SELECT * FROM mac_authorizations WHERE mac_address = ?'),
  getAll: db.prepare('SELECT * FROM mac_authorizations ORDER BY expires_at DESC'),
  delete: db.prepare('DELETE FROM mac_authorizations WHERE mac_address = ?'),
  deleteExpired: db.prepare("DELETE FROM mac_authorizations WHERE julianday(expires_at) <= julianday('now')"),
};

// Export everything
module.exports = {
  db,
  users: userQueries,
  packages: packageQueries,
  sessions: sessionQueries,
  devices: deviceQueries,
  admins: adminQueries,
  oauth: oauthQueries,
  settings: settingQueries,
  logs: logQueries,
  macAuthorizations: macAuthorizationQueries,
};
