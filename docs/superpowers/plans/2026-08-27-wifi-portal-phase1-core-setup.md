# WiFi Portal Phase 1: Core Setup

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build project scaffold, database schema, admin authentication, and captive portal UI

**Architecture:** Express.js server with SQLite, serving both admin SPA and captive portal pages. Admin routes protected with session-based auth. Captive portal public but tracks sessions.

**Tech Stack:** Node.js, Express, better-sqlite3, bcryptjs, express-session, connect-sqlite3

**Spec:** `../SPEC.md`

---

## Global Constraints

- Node.js 18+
- SQLite via better-sqlite3
- bcrypt cost factor: 12
- Session secret: min 32 chars
- All DB queries: parameterized (no SQL injection)
- All user inputs: validated and sanitized

---

## File Structure

```
radius-captive-portal/
├── src/
│   ├── index.js              # Entry point
│   ├── app.js               # Express app
│   ├── config/index.js      # Env loader
│   ├── db/
│   │   ├── index.js         # DB connection
│   │   ├── schema.sql      # Schema
│   │   └── init.js         # Init script
│   ├── routes/
│   │   ├── index.js         # Route aggregator
│   │   ├── auth.js          # Admin auth
│   │   └── portal.js        # Captive portal pages
│   ├── middleware/
│   │   ├── auth.js          # Session check
│   │   └── errorHandler.js  # Error handling
│   └── utils/
│       ├── logger.js
│       └── validators.js
├── public/
│   ├── admin/
│   │   └── index.html       # Placeholder admin page
│   └── captive-portal/
│       ├── index.html       # Login page
│       ├── success.html     # Success page
│       ├── guest.html       # Guest registration
│       └── error.html       # Error page
├── scripts/
│   ├── init-db.js
│   └── create-admin.js
├── .env.example
├── package.json
└── README.md
```

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `.env.example`
- Create: `.gitignore`
- Create: `README.md`

**Interfaces:**
- Produces: `npm install`able package

- [ ] **Step 1: Create package.json**

```json
{
  "name": "wifi-portal",
  "version": "1.0.0",
  "description": "WiFi Captive Portal with RADIUS",
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js",
    "dev": "nodemon src/index.js",
    "init-db": "node scripts/init-db.js",
    "create-admin": "node scripts/create-admin.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "better-sqlite3": "^9.4.0",
    "bcryptjs": "^2.4.3",
    "express-session": "^1.17.3",
    "connect-sqlite3": "^0.9.15",
    "helmet": "^7.1.0",
    "express-rate-limit": "^7.1.5",
    "dotenv": "^16.3.1",
    "winston": "^3.11.0",
    "uuid": "^9.0.1"
  },
  "devDependencies": {
    "nodemon": "^3.0.2"
  }
}
```

- [ ] **Step 2: Create .env.example**

```bash
PORT=3000
NODE_ENV=development

DATABASE_PATH=./data/wifi-portal.db

ADMIN_SESSION_SECRET=change-this-to-at-least-32-characters

LOG_LEVEL=info
```

- [ ] **Step 3: Create .gitignore**

```
node_modules/
.env
data/
*.db
*.log
```

- [ ] **Step 4: Create README.md skeleton**

```markdown
# WiFi Captive Portal

Captive portal with RADIUS for MikroTik.

## Setup

1. Copy `.env.example` to `.env` and fill in values
2. Run `npm install`
3. Run `npm run init-db`
4. Run `npm run create-admin`
5. Run `npm start`
```

- [ ] **Step 5: Commit**

```bash
git init
git add package.json .env.example .gitignore README.md
git commit -m "chore: project scaffold"
```

---

## Task 2: Database Setup

**Files:**
- Create: `src/db/index.js`
- Create: `src/db/schema.sql`
- Create: `scripts/init-db.js`

**Interfaces:**
- Produces: `src/db/index.js` exports `db` object with methods:
  - `getUser(id)`, `getUserByIdentifier(identifier)`
  - `getPackage(id)`, `getActivePackages()`
  - `createSession(data)`, `updateSession(id, data)`
  - `getSession(id)`, `getActiveSessions()`
  - `getSetting(key)`, `setSetting(key, value)`
  - `getAdmin(username)`, `createAdmin(username, hash)`

- [ ] **Step 1: Create schema.sql**

```sql
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
CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON connection_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_oauth_email ON oauth_whitelist(google_email);
```

- [ ] **Step 2: Create src/db/index.js**

```javascript
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

// User queries
const userQueries = {
  getById: db.prepare('SELECT * FROM users WHERE id = ?'),
  getByIdentifier: db.prepare('SELECT * FROM users WHERE identifier = ?'),
  getByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  getAll: db.prepare('SELECT * FROM users ORDER BY created_at DESC'),
  create: db.prepare(`
    INSERT INTO users (type, identifier, email, password_hash, display_name, max_devices)
    VALUES (@type, @identifier, @email, @password_hash, @display_name, @max_devices)
  `),
  update: db.prepare(`
    UPDATE users SET email = @email, display_name = @display_name,
    max_devices = @max_devices, is_active = @is_active
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
    FROM sessions s JOIN users u ON s.user_id = u.id
    WHERE s.is_active = 1 ORDER BY s.start_time DESC
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
};
```

- [ ] **Step 3: Create scripts/init-db.js**

```javascript
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const schemaPath = path.join(__dirname, '../src/db/schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');

// Get database path from env or default
const dbPath = process.env.DATABASE_PATH || './data/wifi-portal.db';

const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

console.log('Initializing database at:', dbPath);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Run schema
db.exec(schema);

// Insert default settings
const defaultSettings = [
  ['captive_portal.title', 'WiFi Portal'],
  ['captive_portal.primary_color', '#1976D2'],
  ['captive_portal.secondary_color', '#424242'],
  ['captive_portal.show_terms', 'true'],
  ['captive_portal.terms_text', 'By using this WiFi, you agree to the acceptable use policy.'],
  ['session.default_max_devices', '3'],
  ['session.idle_timeout_seconds', '300'],
  ['session.activity_threshold_bytes', '1024'],
  ['radius.shared_secret', 'changeme'],
  ['radius.coa_port', '3799'],
  ['radius.default_bandwidth_down', '5000'],
  ['radius.default_bandwidth_up', '2000'],
];

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [key, value] of defaultSettings) {
  insertSetting.run(key, value);
}

db.close();
console.log('Database initialized successfully!');
```

- [ ] **Step 4: Run npm install and init-db**

```bash
cd ~/radius-captive-portal
npm install
npm run init-db
```

- [ ] **Step 5: Commit**

```bash
git add src/db scripts/init-db.js
git commit -m "feat(db): add database schema and init script"
```

---

## Task 3: Express App Setup

**Files:**
- Create: `src/config/index.js`
- Create: `src/app.js`
- Create: `src/index.js`
- Create: `src/middleware/errorHandler.js`
- Create: `src/utils/logger.js`

**Interfaces:**
- Produces: Running Express server on PORT (default 3000)

- [ ] **Step 1: Create src/config/index.js**

```javascript
const dotenv = require('dotenv');
const path = require('path');

// Load .env file
dotenv.config();

function loadConfig() {
  return {
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    databasePath: process.env.DATABASE_PATH || './data/wifi-portal.db',
    sessionSecret: process.env.ADMIN_SESSION_SECRET || 'dev-secret-change-in-production',
    logLevel: process.env.LOG_LEVEL || 'info',
    // Google OAuth (for later)
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    googleCallbackUrl: process.env.GOOGLE_CALLBACK_URL || '',
    // RADIUS
    radiusSharedSecret: process.env.RADIUS_SHARED_SECRET || 'changeme',
    radiusCoaPort: parseInt(process.env.RADIUS_COA_PORT || '3799', 10),
    // WebDAV
    webdavUrl: process.env.WEBDAV_URL || '',
    webdavUsername: process.env.WEBDAV_USERNAME || '',
    webdavPassword: process.env.WEBDAV_PASSWORD || '',
    backupRetention: parseInt(process.env.BACKUP_RETENTION || '10', 10),
  };
}

module.exports = { loadConfig };
```

- [ ] **Step 2: Create src/utils/logger.js**

```javascript
const winston = require('winston');
const { loadConfig } = require('../config');

const config = loadConfig();

const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
  ],
});

module.exports = logger;
```

- [ ] **Step 3: Create src/middleware/errorHandler.js**

```javascript
const logger = require('../utils/logger');

function errorHandler(err, req, res, next) {
  logger.error('Unhandled error:', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  const status = err.status || err.statusCode || 500;
  const message = status === 500 ? 'Internal Server Error' : err.message;

  res.status(status).json({
    error: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
}

module.exports = errorHandler;
```

- [ ] **Step 4: Create src/app.js**

```javascript
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { loadConfig } = require('./config');
const logger = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');

const config = loadConfig();
const app = express();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disabled for portal flexibility
}));

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session store
const sessionStore = new SQLiteStore({
  db: 'sessions.db',
  dir: path.dirname(config.databasePath),
});

// Session configuration
app.use(session({
  store: sessionStore,
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  name: 'wifiportal.sid',
  cookie: {
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
}));

// Rate limiting for admin routes
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: { error: 'Too many requests, please try again later.' },
});

// Apply rate limiter to admin routes
app.use('/admin', adminLimiter);

// Static files
app.use('/admin', express.static(path.join(__dirname, '../public/admin')));
app.use('/', express.static(path.join(__dirname, '../public/captive-portal')));

// Routes
app.use('/', require('./routes/portal'));
app.use('/auth', require('./routes/auth'));
app.use('/admin', require('./routes/auth')); // Admin auth routes
app.use('/admin/api', require('./routes/admin'));

// Error handler
app.use(errorHandler);

module.exports = app;
```

- [ ] **Step 5: Create src/index.js**

```javascript
const app = require('./app');
const { loadConfig } = require('./config');
const logger = require('./utils/logger');

const config = loadConfig();

app.listen(config.port, () => {
  logger.info(`WiFi Portal server started on port ${config.port}`);
  logger.info(`Environment: ${config.nodeEnv}`);
  logger.info(`Database: ${config.databasePath}`);
});
```

- [ ] **Step 6: Test server starts**

```bash
npm start
# Should see: WiFi Portal server started on port 3000
# Press Ctrl+C to stop
```

- [ ] **Step 7: Commit**

```bash
git add src/config src/app.js src/index.js src/middleware src/utils
git commit -m "feat(server): add Express app setup with session"
```

---

## Task 4: Basic Routes & Portal HTML

**Files:**
- Create: `src/routes/index.js` (redirect)
- Create: `public/captive-portal/index.html`
- Create: `public/captive-portal/success.html`
- Create: `public/captive-portal/guest.html`
- Create: `public/captive-portal/error.html`
- Create: `public/admin/index.html` (placeholder)

**Interfaces:**
- Produces: Serving HTML pages for captive portal

- [ ] **Step 1: Create src/routes/index.js**

```javascript
const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.sendFile('index.html', { root: 'public/captive-portal' });
});

module.exports = router;
```

- [ ] **Step 2: Create public/captive-portal/index.html**

```html
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title id="portal-title">WiFi Portal</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #1976D2 0%, #424242 100%);
    }
    .container {
      background: white;
      padding: 2.5rem;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      width: 100%;
      max-width: 420px;
      text-align: center;
    }
    .logo {
      width: 80px;
      height: 80px;
      margin-bottom: 1.5rem;
      background: #1976D2;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-left: auto;
      margin-right: auto;
    }
    .logo svg { width: 48px; height: 48px; fill: white; }
    h1 { color: #1976D2; margin-bottom: 0.5rem; font-size: 1.75rem; }
    .subtitle { color: #666; margin-bottom: 2rem; }
    .tabs {
      display: flex;
      margin-bottom: 1.5rem;
      border-bottom: 2px solid #eee;
    }
    .tab {
      flex: 1;
      padding: 0.75rem;
      cursor: pointer;
      color: #666;
      border: none;
      background: none;
      font-size: 1rem;
      transition: all 0.2s;
    }
    .tab.active { color: #1976D2; border-bottom: 2px solid #1976D2; margin-bottom: -2px; }
    .tab:hover { color: #1976D2; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .form-group { margin-bottom: 1rem; text-align: left; }
    label { display: block; margin-bottom: 0.5rem; color: #333; font-weight: 500; }
    input, select {
      width: 100%;
      padding: 0.875rem;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 1rem;
      transition: border-color 0.2s;
    }
    input:focus, select:focus {
      outline: none;
      border-color: #1976D2;
    }
    .btn {
      width: 100%;
      padding: 1rem;
      background: #1976D2;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    .btn:hover { background: #1565C0; }
    .btn-google {
      background: #4285F4;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
    }
    .btn-google:hover { background: #3367D6; }
    .terms {
      margin-top: 1.5rem;
      font-size: 0.85rem;
      color: #666;
      text-align: left;
    }
    .alert {
      padding: 0.875rem;
      border-radius: 8px;
      margin-bottom: 1rem;
      font-size: 0.9rem;
    }
    .alert-error { background: #FFEBEE; color: #C62828; }
    .alert-success { background: #E8F5E9; color: #2E7D32; }
    .oauth-note {
      font-size: 0.8rem;
      color: #666;
      margin-top: 0.5rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      <svg viewBox="0 0 24 24"><path d="M1 9l2 2c4.97-4.97 13.03-4.97 18 0l2-2C16.93 2.93 7.08 2.93 1 9zm8 8l3 3 3-3c-1.65-1.66-4.34-1.66-6 0zm-4-4l2 2c2.76-2.76 7.24-2.76 10 0l2-2C15.14 9.14 8.87 9.14 5 13z"/></svg>
    </div>
    <h1 id="portal-heading">WiFi Portal</h1>
    <p class="subtitle">Kết nối WiFi của bạn</p>

    <div id="alert-container"></div>

    <div class="tabs">
      <button class="tab active" data-tab="login">Đăng nhập</button>
      <button class="tab" data-tab="guest">Khách</button>
    </div>

    <!-- Login Tab -->
    <div id="tab-login" class="tab-content active">
      <button class="btn btn-google" onclick="loginWithGoogle()">
        <svg width="18" height="18" viewBox="0 0 24 24"><path fill="#fff" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#fff" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#fff" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#fff" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
        Đăng nhập với Google
      </button>
      <p class="oauth-note">Chỉ tài khoản được cho phép mới có thể đăng nhập</p>

      <div style="margin: 1.5rem 0; color: #ccc; display: flex; align-items: center;">
        <hr style="flex: 1;"><span style="padding: 0 1rem;">hoặc</span><hr style="flex: 1;">
      </div>

      <form id="local-login-form" onsubmit="handleLocalLogin(event)">
        <div class="form-group">
          <label for="username">Tài khoản</label>
          <input type="text" id="username" name="username" required autocomplete="username">
        </div>
        <div class="form-group">
          <label for="password">Mật khẩu</label>
          <input type="password" id="password" name="password" required autocomplete="current-password">
        </div>
        <button type="submit" class="btn">Đăng nhập</button>
      </form>
    </div>

    <!-- Guest Tab -->
    <div id="tab-guest" class="tab-content">
      <form id="guest-form" onsubmit="handleGuestRegister(event)">
        <div class="form-group">
          <label for="package">Chọn gói</label>
          <select id="package" name="package_id" required>
            <option value="">-- Chọn gói --</option>
          </select>
        </div>
        <button type="submit" class="btn">Đăng ký</button>
      </form>
    </div>

    <div class="terms" id="terms-container">
      <input type="checkbox" id="terms" required>
      <label for="terms" style="display: inline; font-weight: normal;">Tôi đồng ý với</label>
      <span style="color: #1976D2; cursor: pointer;" onclick="showTerms()">điều khoản sử dụng</span>
    </div>
  </div>

  <script>
    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      });
    });

    // Load packages
    async function loadPackages() {
      try {
        const res = await fetch('/api/packages');
        const packages = await res.json();
        const select = document.getElementById('package');
        packages.forEach(pkg => {
          const opt = document.createElement('option');
          opt.value = pkg.id;
          let label = pkg.name;
          if (pkg.duration_minutes >= 60) {
            label += ` (${pkg.duration_minutes / 60}h)`;
          } else {
            label += ` (${pkg.duration_minutes} phút)`;
          }
          if (pkg.quota_mb) {
            label += ` - ${pkg.quota_mb}MB`;
          }
          opt.textContent = label;
          select.appendChild(opt);
        });
      } catch (err) {
        console.error('Failed to load packages:', err);
      }
    }

    // Google OAuth
    function loginWithGoogle() {
      window.location.href = '/auth/google';
    }

    // Local login
    async function handleLocalLogin(e) {
      e.preventDefault();
      const form = e.target;
      const data = {
        username: form.username.value,
        password: form.password.value
      };

      try {
        const res = await fetch('/auth/local', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        const result = await res.json();
        if (res.ok) {
          showAlert('Đăng nhập thành công! Kết nối WiFi với thông tin đã cấp.', 'success');
          setTimeout(() => window.location.href = '/success.html', 1500);
        } else {
          showAlert(result.error || 'Đăng nhập thất bại', 'error');
        }
      } catch (err) {
        showAlert('Lỗi kết nối', 'error');
      }
    }

    // Guest registration
    async function handleGuestRegister(e) {
      e.preventDefault();
      if (!document.getElementById('terms').checked) {
        showAlert('Vui lòng đồng ý với điều khoản sử dụng', 'error');
        return;
      }

      const packageId = document.getElementById('package').value;
      if (!packageId) {
        showAlert('Vui lòng chọn gói', 'error');
        return;
      }

      try {
        const res = await fetch('/api/guest/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ package_id: parseInt(packageId) })
        });
        const result = await res.json();
        if (res.ok) {
          sessionStorage.setItem('guest_credentials', JSON.stringify(result));
          window.location.href = '/success.html';
        } else {
          showAlert(result.error || 'Đăng ký thất bại', 'error');
        }
      } catch (err) {
        showAlert('Lỗi kết nối', 'error');
      }
    }

    function showAlert(message, type) {
      const container = document.getElementById('alert-container');
      container.innerHTML = `<div class="alert alert-${type}">${message}</div>`;
    }

    function showTerms() {
      alert('Điều khoản sử dụng WiFi:\n\n1. Sử dụng WiFi có trách nhiệm\n2. Không truy cập nội dung bất hợp pháp\n3. Không chia sẻ thông tin đăng nhập\n4. Tuân thủ quy định của tổ chức');
    }

    // Init
    loadPackages();
  </script>
</body>
</html>
```

- [ ] **Step 3: Create public/captive-portal/success.html**

```html
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Đăng nhập thành công</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #2E7D32 0%, #1976D2 100%);
    }
    .container {
      background: white;
      padding: 2.5rem;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      width: 100%;
      max-width: 420px;
      text-align: center;
    }
    .checkmark {
      width: 80px;
      height: 80px;
      background: #2E7D32;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 1.5rem;
    }
    .checkmark svg { width: 48px; height: 48px; fill: white; }
    h1 { color: #2E7D32; margin-bottom: 0.5rem; font-size: 1.5rem; }
    .credentials {
      background: #F5F5F5;
      padding: 1.5rem;
      border-radius: 12px;
      margin: 1.5rem 0;
      text-align: left;
    }
    .credential-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 0.75rem;
    }
    .credential-row:last-child { margin-bottom: 0; }
    .credential-label { color: #666; font-size: 0.9rem; }
    .credential-value {
      font-family: monospace;
      font-size: 1.1rem;
      font-weight: 600;
      color: #1976D2;
    }
    .copy-btn {
      background: #1976D2;
      color: white;
      border: none;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.9rem;
    }
    .copy-btn:hover { background: #1565C0; }
    .info-box {
      background: #E3F2FD;
      padding: 1rem;
      border-radius: 8px;
      text-align: left;
      margin-bottom: 1rem;
    }
    .info-box h3 { color: #1976D2; margin-bottom: 0.5rem; font-size: 0.95rem; }
    .info-box p { color: #333; font-size: 0.85rem; line-height: 1.5; }
    .btn {
      display: inline-block;
      width: 100%;
      padding: 1rem;
      background: #424242;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      cursor: pointer;
      text-decoration: none;
      margin-top: 1rem;
    }
    .btn:hover { background: #333; }
  </style>
</head>
<body>
  <div class="container">
    <div class="checkmark">
      <svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>
    </div>
    <h1>Đăng nhập thành công!</h1>

    <div class="info-box">
      <h3>Thông tin kết nối</h3>
      <div class="credential-row">
        <span class="credential-label">SSID:</span>
        <span class="credential-value" id="ssid">Guest-Network</span>
      </div>
    </div>

    <div class="credentials" id="credentials-box">
      <div class="credential-row">
        <span class="credential-label">Tài khoản:</span>
        <span class="credential-value" id="username">-</span>
      </div>
      <div class="credential-row">
        <span class="credential-label">Mật khẩu:</span>
        <span class="credential-value" id="password">-</span>
      </div>
    </div>

    <p style="color: #666; font-size: 0.85rem; margin-bottom: 1rem;">
      Kết nối WiFi với thông tin bên trên.<br>
      Thông tin chỉ hiển thị một lần duy nhất!
    </p>

    <button class="btn" onclick="logout()">Đăng xuất</button>
  </div>

  <script>
    function logout() {
      sessionStorage.removeItem('guest_credentials');
      window.location.href = '/';
    }

    // Load credentials from session
    const creds = sessionStorage.getItem('guest_credentials');
    if (creds) {
      const data = JSON.parse(creds);
      document.getElementById('username').textContent = data.username;
      document.getElementById('password').textContent = data.password;
      if (data.package) {
        document.getElementById('ssid').textContent = 'Guest-Network';
      }
    } else {
      // Check if logged in via OAuth
      window.location.href = '/';
    }
  </script>
</body>
</html>
```

- [ ] **Step 4: Create public/captive-portal/error.html**

```html
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lỗi</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #C62828 0%, #424242 100%);
    }
    .container {
      background: white;
      padding: 2.5rem;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      width: 100%;
      max-width: 420px;
      text-align: center;
    }
    .error-icon {
      width: 80px;
      height: 80px;
      background: #C62828;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 1.5rem;
    }
    .error-icon svg { width: 48px; height: 48px; fill: white; }
    h1 { color: #C62828; margin-bottom: 1rem; }
    p { color: #666; margin-bottom: 1.5rem; line-height: 1.5; }
    .btn {
      display: inline-block;
      padding: 1rem 2rem;
      background: #1976D2;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      cursor: pointer;
      text-decoration: none;
    }
    .btn:hover { background: #1565C0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="error-icon">
      <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
    </div>
    <h1 id="error-title">Đã xảy ra lỗi</h1>
    <p id="error-message">Vui lòng thử đăng nhập lại.</p>
    <a href="/" class="btn">Quay lại</a>
  </div>

  <script>
    const params = new URLSearchParams(window.location.search);
    const error = params.get('error');
    if (error) {
      if (error === 'unauthorized') {
        document.getElementById('error-title').textContent = 'Không có quyền truy cập';
        document.getElementById('error-message').textContent = 'Tài khoản Google của bạn chưa được cho phép. Vui lòng liên hệ quản trị viên.';
      } else if (error === 'oauth_failed') {
        document.getElementById('error-title').textContent = 'Đăng nhập Google thất bại';
        document.getElementById('error-message').textContent = 'Không thể xác thực với Google. Vui lòng thử lại.';
      } else {
        document.getElementById('error-message').textContent = decodeURIComponent(error);
      }
    }
  </script>
</body>
</html>
```

- [ ] **Step 5: Create public/admin/index.html (placeholder)**

```html
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin - WiFi Portal</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      background: #f5f5f5;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
    }
    .container {
      background: white;
      padding: 2rem;
      border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      text-align: center;
    }
    h1 { color: #1976D2; }
    p { color: #666; margin: 1rem 0; }
    a { color: #1976D2; }
  </style>
</head>
<body>
  <div class="container">
    <h1>WiFi Portal Admin</h1>
    <p>Dashboard đang được xây dựng...</p>
    <p>Xem <a href="/admin/api/health">API status</a></p>
  </div>
</body>
</html>
```

- [ ] **Step 6: Commit**

```bash
git add public/
git commit -m "feat(portal): add captive portal HTML pages"
```

---

## Task 5: Admin Authentication

**Files:**
- Create: `src/routes/auth.js`
- Create: `scripts/create-admin.js`
- Modify: `src/middleware/auth.js` (new file)

**Interfaces:**
- Produces: Admin login/logout with bcrypt passwords

- [ ] **Step 1: Create src/middleware/auth.js**

```javascript
function requireAuth(req, res, next) {
  if (req.session && req.session.adminId) {
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.redirect('/admin/login');
}

function requireApiAuth(req, res, next) {
  if (req.session && req.session.adminId) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

module.exports = { requireAuth, requireApiAuth };
```

- [ ] **Step 2: Create src/routes/auth.js**

```javascript
const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { users, admins, oauth, settings } = require('../db');
const { requireApiAuth } = require('../middleware/auth');
const logger = require('../utils/logger');

// Admin login page
router.get('/login', (req, res) => {
  if (req.session.adminId) {
    return res.redirect('/admin');
  }
  res.sendFile('login.html', { root: 'public/admin' });
});

// Admin login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const admin = admins.getByUsername.get(username);
    if (!admin) {
      logger.warn('Failed login attempt: user not found', { username });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) {
      logger.warn('Failed login attempt: wrong password', { username });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update last login
    admins.updateLastLogin.run(admin.id);

    // Set session
    req.session.adminId = admin.id;
    req.session.adminUsername = admin.username;

    logger.info('Admin logged in', { username, adminId: admin.id });

    res.json({ success: true, username: admin.username });
  } catch (err) {
    logger.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin logout
router.post('/logout', requireApiAuth, (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      logger.error('Logout error:', err);
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.json({ success: true });
  });
});

// Get current admin
router.get('/me', requireApiAuth, (req, res) => {
  const admin = admins.getById.get(req.session.adminId);
  if (!admin) {
    return res.status(404).json({ error: 'Admin not found' });
  }
  res.json({
    id: admin.id,
    username: admin.username,
    lastLogin: admin.last_login,
  });
});

// Guest local login (from captive portal)
router.post('/local', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // Find user
    const user = users.getByIdentifier.get(username);
    if (!user || user.type !== 'local') {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.is_active) {
      return res.status(401).json({ error: 'Account is disabled' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Return success - actual session creation happens via RADIUS
    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.identifier,
        type: user.type,
      },
    });
  } catch (err) {
    logger.error('Local login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Google OAuth routes (placeholder - implemented in Phase 2)
router.get('/google', (req, res) => {
  // Will implement OAuth in Phase 2
  res.status(501).json({ error: 'Google OAuth not configured' });
});

router.get('/google/callback', (req, res) => {
  res.redirect('/error.html?error=oauth_not_configured');
});

module.exports = router;
```

- [ ] **Step 3: Create public/admin/login.html**

```html
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Login - WiFi Portal</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f5f5f5;
    }
    .login-box {
      background: white;
      padding: 2.5rem;
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.1);
      width: 100%;
      max-width: 380px;
    }
    h1 {
      color: #1976D2;
      margin-bottom: 0.5rem;
      font-size: 1.5rem;
    }
    .subtitle { color: #666; margin-bottom: 2rem; }
    .form-group { margin-bottom: 1rem; }
    label { display: block; margin-bottom: 0.5rem; color: #333; font-weight: 500; }
    input {
      width: 100%;
      padding: 0.875rem;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 1rem;
    }
    input:focus { outline: none; border-color: #1976D2; }
    .btn {
      width: 100%;
      padding: 1rem;
      background: #1976D2;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      margin-top: 1rem;
    }
    .btn:hover { background: #1565C0; }
    .error {
      background: #FFEBEE;
      color: #C62828;
      padding: 0.875rem;
      border-radius: 8px;
      margin-bottom: 1rem;
      font-size: 0.9rem;
    }
  </style>
</head>
<body>
  <div class="login-box">
    <h1>WiFi Portal Admin</h1>
    <p class="subtitle">Đăng nhập quản trị</p>

    <div id="error" class="error" style="display: none;"></div>

    <form id="login-form">
      <div class="form-group">
        <label for="username">Tài khoản</label>
        <input type="text" id="username" name="username" required autocomplete="username">
      </div>
      <div class="form-group">
        <label for="password">Mật khẩu</label>
        <input type="password" id="password" name="password" required autocomplete="current-password">
      </div>
      <button type="submit" class="btn">Đăng nhập</button>
    </form>
  </div>

  <script>
    const form = document.getElementById('login-form');
    const errorDiv = document.getElementById('error');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorDiv.style.display = 'none';

      const data = {
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
      };

      try {
        const res = await fetch('/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });

        const result = await res.json();

        if (res.ok) {
          window.location.href = '/admin';
        } else {
          errorDiv.textContent = result.error || 'Đăng nhập thất bại';
          errorDiv.style.display = 'block';
        }
      } catch (err) {
        errorDiv.textContent = 'Lỗi kết nối';
        errorDiv.style.display = 'block';
      }
    });
  </script>
</body>
</html>
```

- [ ] **Step 4: Create scripts/create-admin.js**

```javascript
const bcrypt = require('bcryptjs');
const readline = require('readline');
const { admins, db } = require('../src/db');
const logger = require('../src/utils/logger');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

async function main() {
  console.log('\n=== Create Admin Account ===\n');

  const username = await ask('Username: ');
  if (!username) {
    console.log('Username required');
    process.exit(1);
  }

  // Check if exists
  const existing = admins.getByUsername.get(username);
  if (existing) {
    console.log('Admin already exists:', username);
    process.exit(1);
  }

  const password = await ask('Password: ');
  if (!password || password.length < 8) {
    console.log('Password must be at least 8 characters');
    process.exit(1);
  }

  const confirm = await ask('Confirm password: ');
  if (password !== confirm) {
    console.log('Passwords do not match');
    process.exit(1);
  }

  rl.close();

  const passwordHash = await bcrypt.hash(password, 12);

  const result = admins.create.run({ username, password_hash: passwordHash });

  console.log('\nAdmin created successfully!');
  console.log('ID:', result.lastInsertRowid);
  console.log('Username:', username);
}

main().catch((err) => {
  logger.error('Error creating admin:', err);
  process.exit(1);
});
```

- [ ] **Step 5: Test admin creation**

```bash
# Run (will prompt for username/password)
npm run create-admin
# Example: admin / MySecurePassword123
```

- [ ] **Step 6: Commit**

```bash
git add src/routes/auth.js src/middleware/auth.js scripts/create-admin.js public/admin/
git commit -m "feat(auth): add admin authentication with bcrypt"
```

---

## Task 6: Guest Registration API

**Files:**
- Create: `src/routes/api/guest.js`
- Create: `src/routes/api/packages.js`

**Interfaces:**
- Produces: Guest registration endpoint, package listing

- [ ] **Step 1: Create src/routes/api/packages.js**

```javascript
const express = require('express');
const router = express.Router();
const { packages } = require('../../db');
const { requireApiAuth } = require('../../middleware/auth');

// List all packages (public)
router.get('/', (req, res) => {
  try {
    const activePackages = packages.getActive.all();
    res.json(activePackages);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch packages' });
  }
});

// Get single package (public)
router.get('/:id', (req, res) => {
  try {
    const pkg = packages.getById.get(req.params.id);
    if (!pkg) {
      return res.status(404).json({ error: 'Package not found' });
    }
    res.json(pkg);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch package' });
  }
});

// Admin only routes below
router.use(requireApiAuth);

// Create package
router.post('/', (req, res) => {
  try {
    const { name, duration_minutes, quota_mb, bandwidth_down_kbps,
            bandwidth_up_kbps, max_devices } = req.body;

    if (!name || !duration_minutes) {
      return res.status(400).json({ error: 'Name and duration required' });
    }

    const result = packages.create.run({
      name,
      duration_minutes: parseInt(duration_minutes),
      quota_mb: quota_mb ? parseInt(quota_mb) : null,
      bandwidth_down_kbps: parseInt(bandwidth_down_kbps) || 5000,
      bandwidth_up_kbps: parseInt(bandwidth_up_kbps) || 2000,
      max_devices: parseInt(max_devices) || 1,
      created_by: req.session.adminId,
    });

    res.json({ id: result.lastInsertRowid, message: 'Package created' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create package' });
  }
});

// Update package
router.put('/:id', (req, res) => {
  try {
    const pkg = packages.getById.get(req.params.id);
    if (!pkg) {
      return res.status(404).json({ error: 'Package not found' });
    }

    const { name, duration_minutes, quota_mb, bandwidth_down_kbps,
            bandwidth_up_kbps, max_devices, is_active } = req.body;

    packages.update.run({
      id: req.params.id,
      name: name || pkg.name,
      duration_minutes: duration_minutes ? parseInt(duration_minutes) : pkg.duration_minutes,
      quota_mb: quota_mb !== undefined ? (quota_mb ? parseInt(quota_mb) : null) : pkg.quota_mb,
      bandwidth_down_kbps: bandwidth_down_kbps ? parseInt(bandwidth_down_kbps) : pkg.bandwidth_down_kbps,
      bandwidth_up_kbps: bandwidth_up_kbps ? parseInt(bandwidth_up_kbps) : pkg.bandwidth_up_kbps,
      max_devices: max_devices ? parseInt(max_devices) : pkg.max_devices,
      is_active: is_active !== undefined ? (is_active ? 1 : 0) : pkg.is_active,
    });

    res.json({ message: 'Package updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update package' });
  }
});

// Delete package
router.delete('/:id', (req, res) => {
  try {
    packages.delete.run(req.params.id);
    res.json({ message: 'Package deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete package' });
  }
});

module.exports = router;
```

- [ ] **Step 2: Create src/routes/api/guest.js**

```javascript
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const { users, packages, sessions, devices, logs } = require('../../db');
const logger = require('../../utils/logger');

// Generate random credentials
function generateCredentials() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const suffix = Array.from({ length: 6 }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join('');

  const passwordChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const password = Array.from({ length: 12 }, () =>
    passwordChars[Math.floor(Math.random() * passwordChars.length)]
  ).join('');

  return {
    username: `guest-${suffix}`,
    password,
  };
}

// Guest registration
router.post('/register', async (req, res) => {
  try {
    const { package_id, mac_address } = req.body;

    // Validate package
    const pkg = packages.getById.get(package_id);
    if (!pkg || !pkg.is_active) {
      return res.status(400).json({ error: 'Invalid or inactive package' });
    }

    // Generate credentials
    const { username, password } = generateCredentials();

    // Create user
    const userResult = users.create.run({
      type: 'guest',
      identifier: username,
      email: null,
      password_hash: null, // Will store bcrypt hash
      display_name: username,
      max_devices: pkg.max_devices,
    });

    const userId = userResult.lastInsertRowid;

    // Hash password for future RADIUS auth
    const bcrypt = require('bcryptjs');
    const passwordHash = await bcrypt.hash(password, 10);

    // Update user with password hash
    require('../../db').db.prepare(
      'UPDATE users SET password_hash = ? WHERE id = ?'
    ).run(passwordHash, userId);

    logger.info('Guest registered', { userId, username, packageId: package_id });

    res.json({
      success: true,
      username,
      password,
      package: {
        name: pkg.name,
        duration_minutes: pkg.duration_minutes,
        quota_mb: pkg.quota_mb,
      },
    });
  } catch (err) {
    logger.error('Guest registration error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Get available packages (for portal)
router.get('/packages', (req, res) => {
  try {
    const activePackages = packages.getActive.all();
    res.json(activePackages.map(pkg => ({
      id: pkg.id,
      name: pkg.name,
      duration_minutes: pkg.duration_minutes,
      quota_mb: pkg.quota_mb,
      bandwidth_down_kbps: pkg.bandwidth_down_kbps,
      bandwidth_up_kbps: pkg.bandwidth_up_kbps,
    })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch packages' });
  }
});

module.exports = router;
```

- [ ] **Step 3: Update src/routes/index.js to mount API routes**

```javascript
const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.sendFile('index.html', { root: 'public/captive-portal' });
});

module.exports = router;
```

- [ ] **Step 4: Update src/app.js to mount API routes**

```javascript
// Add after other routes
app.use('/api/packages', require('./routes/api/packages'));
app.use('/api/guest', require('./routes/api/guest'));
app.use('/api', require('./routes/api'));
```

- [ ] **Step 5: Create src/routes/api/index.js**

```javascript
const express = require('express');
const router = express.Router();
const { requireApiAuth } = require('../middleware/auth');

// Health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

module.exports = router;
```

- [ ] **Step 6: Test guest registration**

```bash
npm start
# In another terminal:
curl -X POST http://localhost:3000/api/guest/register \
  -H "Content-Type: application/json" \
  -d '{"package_id": 1}'
# Should return: {"success":true,"username":"guest-xxxxxx","password":"..."}
```

- [ ] **Step 7: Commit**

```bash
git add src/routes/api/
git commit -m "feat(guest): add guest registration API"
```

---

## Task 7: Sample Data Setup

**Files:**
- Create: `scripts/setup-sample-data.js`

**Interfaces:**
- Produces: Sample packages for testing

- [ ] **Step 1: Create scripts/setup-sample-data.js**

```javascript
const { packages, settings } = require('../src/db');
const logger = require('../src/utils/logger');

// Sample packages
const samplePackages = [
  {
    name: '15 phút',
    duration_minutes: 15,
    quota_mb: 100,
    bandwidth_down_kbps: 5000,
    bandwidth_up_kbps: 2000,
    max_devices: 1,
  },
  {
    name: '1 giờ',
    duration_minutes: 60,
    quota_mb: 500,
    bandwidth_down_kbps: 5000,
    bandwidth_up_kbps: 2000,
    max_devices: 2,
  },
  {
    name: '4 giờ',
    duration_minutes: 240,
    quota_mb: 2000,
    bandwidth_down_kbps: 10000,
    bandwidth_up_kbps: 5000,
    max_devices: 3,
  },
  {
    name: 'Ngày (8 giờ)',
    duration_minutes: 480,
    quota_mb: null, // Unlimited
    bandwidth_down_kbps: 10000,
    bandwidth_up_kbps: 5000,
    max_devices: 5,
  },
];

async function main() {
  console.log('\n=== Setup Sample Data ===\n');

  // Check if packages exist
  const existing = packages.getActive.all();
  if (existing.length > 0) {
    console.log('Packages already exist. Skipping...');
    process.exit(0);
  }

  for (const pkg of samplePackages) {
    const result = packages.create.run({
      ...pkg,
      created_by: 1, // Assuming admin exists
    });
    console.log(`Created package: ${pkg.name} (ID: ${result.lastInsertRowid})`);
  }

  console.log('\nSample packages created successfully!');
}

main().catch((err) => {
  logger.error('Error setting up sample data:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Run sample data setup**

```bash
npm run setup-sample-data
# Or if you haven't created admin yet:
node scripts/init-db.js && npm run create-admin && npm run setup-sample-data
```

- [ ] **Step 3: Commit**

```bash
git add scripts/setup-sample-data.js
git commit -m "chore: add sample data setup script"
```

---

## Task 8: Phase 1 Verification

**Files:** None (testing phase)

- [ ] **Step 1: Start server and verify**

```bash
npm start
# Server should start on port 3000
```

- [ ] **Step 2: Test captive portal**

```
# Open browser to:
http://localhost:3000
# Should see login page with tabs
```

- [ ] **Step 3: Test admin login**

```
# Open browser to:
http://localhost:3000/auth/login
# Should see admin login form
# Login with created admin credentials
```

- [ ] **Step 4: Test API health**

```bash
curl http://localhost:3000/api/health
# Should return: {"status":"ok","timestamp":"..."}
```

- [ ] **Step 5: Test package listing**

```bash
curl http://localhost:3000/api/packages
# Should return array of sample packages
```

- [ ] **Step 6: Test guest registration**

```bash
curl -X POST http://localhost:3000/api/guest/register \
  -H "Content-Type: application/json" \
  -d '{"package_id": 1}'
# Should return credentials
```

- [ ] **Step 7: Final commit for Phase 1**

```bash
git add -A
git commit -m "feat(phase1): core setup complete - portal, auth, guest registration"
git tag phase1-complete
```

---

## Phase 1 Summary

**Completed:**
- Project scaffold with package.json
- SQLite database with full schema
- Express server with session management
- Captive portal HTML pages (login, success, error)
- Admin authentication with bcrypt
- Guest registration API
- Sample packages setup

**Next (Phase 2):**
- Google OAuth integration
- RADIUS server for MikroTik
- Session management with activity tracking
- CoA server for disconnect

**To Continue:**
```bash
cd ~/radius-captive-portal
npm run create-admin  # If not done
npm run setup-sample-data
npm start
```
