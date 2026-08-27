-- Admins
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login DATETIME
);

-- Users
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT CHECK(type IN ('oauth', 'local', 'guest')) NOT NULL,
  identifier TEXT NOT NULL,
  email TEXT,
  password_hash TEXT,
  display_name TEXT,
  max_devices INTEGER DEFAULT 3,
  is_active BOOLEAN DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- OAuth Whitelist
CREATE TABLE IF NOT EXISTS oauth_whitelist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  google_email TEXT UNIQUE NOT NULL,
  allowed_by INTEGER REFERENCES admins(id),
  allowed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Packages
CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  quota_mb INTEGER,
  bandwidth_down_kbps INTEGER DEFAULT 5000,
  bandwidth_up_kbps INTEGER DEFAULT 2000,
  max_devices INTEGER DEFAULT 1,
  is_active BOOLEAN DEFAULT 1,
  created_by INTEGER REFERENCES admins(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  package_id INTEGER REFERENCES packages(id),
  mac_address TEXT NOT NULL,
  ip_address TEXT,
  nas_identifier TEXT,
  username TEXT NOT NULL,
  session_id TEXT UNIQUE,
  start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
  idle_seconds INTEGER DEFAULT 0,
  quota_used_mb INTEGER DEFAULT 0,
  quota_total_mb INTEGER,
  bandwidth_down_kbps INTEGER,
  bandwidth_up_kbps INTEGER,
  is_active BOOLEAN DEFAULT 1,
  terminated_by TEXT,
  end_time DATETIME
);

-- Devices
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  mac_address TEXT UNIQUE NOT NULL,
  device_name TEXT,
  session_id INTEGER REFERENCES sessions(id),
  first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_online BOOLEAN DEFAULT 0
);

-- MAC addresses authorised by the captive portal. RADIUS reads this state.
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

-- Connection Logs
CREATE TABLE IF NOT EXISTS connection_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  session_id TEXT,
  mac_address TEXT,
  ip_address TEXT,
  action TEXT NOT NULL,
  nas_identifier TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  details TEXT
);

-- Settings
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Backups
CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  size_bytes INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  status TEXT DEFAULT 'pending'
);

-- Branding Assets
CREATE TABLE IF NOT EXISTS branding_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  filename TEXT NOT NULL,
  original_name TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(is_active, start_time);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_mac ON devices(mac_address);
CREATE INDEX IF NOT EXISTS idx_mac_authorizations_expiry ON mac_authorizations(expires_at);
CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON connection_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_oauth_email ON oauth_whitelist(google_email);
