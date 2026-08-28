# WiFi Captive Portal + Admin Dashboard + FreeRADIUS

> **Tài liệu lịch sử, không phải cấu hình triển khai.** Nội dung bên dưới mô tả bản thử nghiệm có Google OAuth và Node.js RADIUS server, hai thành phần không còn nằm trong runtime. Xem [docs/current-architecture.md](docs/current-architecture.md), README và các hướng dẫn router trong `docs/` để triển khai hệ thống hiện hành.

**Version:** 1.0.0
**Date:** 2026-08-27
**Status:** Draft

---

## 1. Overview

### 1.1 System Purpose

A complete captive portal solution for schools/companies with:
- Guest WiFi access with time/bandwidth limits
- User authentication via Google OAuth (admin-controlled whitelist) or local accounts
- Admin dashboard for user management, package configuration, and analytics
- FreeRADIUS integration with MikroTik routers
- Automated WebDAV backup

### 1.2 Scope

| Included | Excluded |
|----------|----------|
| Captive portal UI | Network hardware procurement |
| Admin dashboard | WiFi access point installation |
| RADIUS/CoA server | Router/AP configuration |
| User management | SSL certificate procurement |
| Session management | Domain registration |
| Backup system | Google Cloud Project setup |

### 1.3 Assumptions

- MikroTik router configured as RADIUS client (RFC 3576)
- Access Points supporting WPA Enterprise (RADIUS authentication)
- WebDAV server accessible for backups
- Domain and SSL certificate already configured
- Node.js 18+ available on server

---

## 2. Architecture

### 2.1 System Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         CLIENTS                                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                     │
│  │   Mobile    │  │   Laptop    │  │    IoT      │                     │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘                     │
└─────────┼─────────────────┼─────────────────┼─────────────────────────┘
          │                 │                 │
          └─────────────────┼─────────────────┘
                            │ WiFi (WPA Enterprise)
                            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    MIKROTIK ROUTER (NAS)                                │
│  - RADIUS Client → sends Access-Request to Server                      │
│  - CoA Server → receives Change of Authorization                        │
│  - VLANs → separates guest network                                      │
└─────────────────────────────────────────────────────────────────────────┘
                            │
                            │ RADIUS (UDP 1812/1813)
                            │ CoA (UDP 3799)
                            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      NODE.JS APPLICATION                                 │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                         EXPRESS SERVER                           │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │    │
│  │  │  Admin   │ │ Captive  │ │  OAuth   │ │   RADIUS/CoA     │  │    │
│  │  │ Dashboard│ │ Portal   │ │  Google  │ │   Server         │  │    │
│  │  │   :3000  │ │   :3000  │ │          │ │   UDP :3799      │  │    │
│  │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────────┬─────────┘  │    │
│  └───────┼────────────┼────────────┼─────────────────┼─────────────┘    │
│          │            │            │                 │                 │
│  ┌───────┴────────────┴────────────┴─────────────────┴─────────────┐   │
│  │                      SERVICE LAYER                               │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │   │
│  │  │  Auth    │ │ Session  │ │ Package  │ │  User    │ │ Backup │ │   │
│  │  │ Service │ │ Manager  │ │ Manager │ │ Manager  │ │Service │ │   │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └────────┘ │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              │                                          │
│  ┌───────────────────────────┴───────────────────────────────────────┐  │
│  │                     SQLITE DATABASE                                │  │
│  │  (users, sessions, packages, devices, logs, settings, oauth)    │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                            │
                     WebDAV (HTTPS)
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      EXTERNAL SERVICES                                  │
│  ┌─────────────┐  ┌─────────────┐                                       │
│  │   Google    │  │   WebDAV    │                                       │
│  │   OAuth     │  │   Server    │                                       │
│  └─────────────┘  └─────────────┘                                       │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Component Responsibilities

| Component | Responsibility |
|-----------|----------------|
| **Captive Portal** | Login UI, guest registration, OAuth flow |
| **Admin Dashboard** | SPA for system management |
| **RADIUS Server** | Authentication (PAP), accounting, CoA |
| **Auth Service** | Password verification, session creation |
| **Session Manager** | Activity tracking, quota enforcement |
| **Package Manager** | CRUD for bandwidth packages |
| **User Manager** | User CRUD, OAuth whitelist management |
| **Backup Service** | SQLite dump, compress, upload to WebDAV |

### 2.3 Port Configuration

| Port | Protocol | Service |
|------|----------|---------|
| 3000 | TCP | Express (HTTP/HTTPS) |
| 3799 | UDP | RADIUS CoA Server |
| 1812 | UDP | RADIUS Auth (from MikroTik) |
| 1813 | UDP | RADIUS Accounting (from MikroTik) |

---

## 3. Data Model

### 3.1 Database Schema

```sql
-- Admins (local only)
CREATE TABLE admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login DATETIME
);

-- Users (all types)
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT CHECK(type IN ('oauth', 'local', 'guest')) NOT NULL,
  identifier TEXT NOT NULL,  -- google_id or username or auto-generated
  email TEXT,
  password_hash TEXT,         -- NULL for oauth
  display_name TEXT,
  max_devices INTEGER DEFAULT 3,
  is_active BOOLEAN DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- OAuth whitelist (which emails can use OAuth)
CREATE TABLE oauth_whitelist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  google_email TEXT UNIQUE NOT NULL,
  allowed_by INTEGER REFERENCES admins(id),
  allowed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Bandwidth packages
CREATE TABLE packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  quota_mb INTEGER,           -- NULL = unlimited
  bandwidth_down_kbps INTEGER DEFAULT 5000,
  bandwidth_up_kbps INTEGER DEFAULT 2000,
  max_devices INTEGER DEFAULT 1,
  is_active BOOLEAN DEFAULT 1,
  created_by INTEGER REFERENCES admins(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Active/recent sessions
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  package_id INTEGER REFERENCES packages(id),
  mac_address TEXT NOT NULL,
  ip_address TEXT,
  nas_identifier TEXT,
  username TEXT NOT NULL,
  session_id TEXT UNIQUE,      -- RADIUS Session-Id
  start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
  idle_seconds INTEGER DEFAULT 0,
  quota_used_mb INTEGER DEFAULT 0,
  quota_total_mb INTEGER,
  bandwidth_down_kbps INTEGER,
  bandwidth_up_kbps INTEGER,
  is_active BOOLEAN DEFAULT 1,
  terminated_by TEXT,          -- 'user', 'admin', 'expired', 'quota'
  end_time DATETIME
);

-- Connected devices per user
CREATE TABLE devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  mac_address TEXT UNIQUE NOT NULL,
  device_name TEXT,
  session_id INTEGER REFERENCES sessions(id),
  first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_online BOOLEAN DEFAULT 0
);

-- Connection history/logs
CREATE TABLE connection_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  session_id TEXT,
  mac_address TEXT,
  ip_address TEXT,
  action TEXT NOT NULL,        -- 'login', 'logout', 'kick', 'timeout'
  nas_identifier TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  details TEXT
);

-- System settings (branding, config)
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Backup history
CREATE TABLE backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  size_bytes INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  status TEXT DEFAULT 'pending'
);

-- Custom branding assets
CREATE TABLE branding_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,          -- 'logo', 'background', 'favicon'
  filename TEXT NOT NULL,
  original_name TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_active ON sessions(is_active, start_time);
CREATE INDEX idx_devices_user ON devices(user_id);
CREATE INDEX idx_devices_mac ON devices(mac_address);
CREATE INDEX idx_logs_timestamp ON connection_logs(timestamp);
CREATE INDEX idx_oauth_email ON oauth_whitelist(google_email);
```

### 3.2 Default Settings

```json
{
  "captive_portal": {
    "title": "WiFi Portal",
    "logo_url": null,
    "background_url": null,
    "primary_color": "#1976D2",
    "secondary_color": "#424242",
    "show_terms": true,
    "terms_text": "By using this WiFi, you agree to the acceptable use policy."
  },
  "session": {
    "default_max_devices": 3,
    "idle_timeout_seconds": 300,
    "activity_threshold_bytes": 1024
  },
  "backup": {
    "webdav_url": "",
    "webdav_username": "",
    "webdav_password": "",
    "retention_count": 10,
    "auto_backup_hours": 24
  },
  "radius": {
    "shared_secret": "changeme",
    "coa_port": 3799,
    "default_bandwidth_down": 5000,
    "default_bandwidth_up": 2000
  }
}
```

---

## 4. User Authentication

### 4.1 Login Methods

| Method | Description | Flow |
|--------|-------------|------|
| **Google OAuth** | Sign in with Google, email must be whitelisted | OAuth → Check whitelist → Create/Update session |
| **Local Account** | Username + password | Verify → Create session |
| **Guest** | Select package, get auto-generated credentials | Select package → Generate username/password |

### 4.2 Google OAuth Flow

```
1. User clicks "Sign in with Google"
2. Redirect to Google OAuth consent
3. Google callback with authorization code
4. Server exchanges code for user info
5. Check if email is in oauth_whitelist
   - If NO → Show "Access Denied" page
   - If YES → Continue
6. Check if user exists:
   - NO → Create user with type='oauth'
   - YES → Update last_login
7. Create session → Redirect to success page
```

#### Walled Garden Domain Requirements (Pre-Authentication)

For Google OAuth to function before authentication, routers/APs must whitelist:

| Domain | Role |
| :--- | :--- |
| `portal.yourcompany.com` | Captive Portal web UI & OAuth Callback |
| `accounts.google.com` | Google Sign-in & consent screen |
| `accounts.youtube.com` | Google account SSO / multi-login state |
| `ssl.gstatic.com`, `fonts.gstatic.com` | Google static CDN assets, icons, fonts |
| `fonts.googleapis.com` | Google UI typography |
| `apis.google.com`, `play.google.com` | Google OAuth scripts & client services |
| `*.google.com`, `*.gstatic.com`, `*.googleapis.com` | Recommended wildcard whitelist |

### 4.3 OAuth Whitelist Management


- Only admins can add/remove emails from whitelist
- Whitelist is per-user (each whitelist entry links to a user account)
- Multiple emails can be whitelisted per user (family members, etc.)
- No automatic creation of users from OAuth

### 4.4 Guest Registration Flow

```
1. User visits captive portal (not logged in)
2. Clicks "Guest Access"
3. Sees list of available packages
4. Selects package
5. System generates:
   - Username: guest-{random 6 chars}
   - Password: {random 12 chars}
6. Display credentials to user (shown once)
7. User connects to WiFi with credentials
```

---

## 5. Session Management

### 5.1 Activity-Based Timer Logic

The session timer only counts down when user is **idle** (no significant traffic).

```javascript
// Pseudocode
const ACTIVITY_THRESHOLD = 1024; // bytes
const IDLE_CHECK_INTERVAL = 60;  // seconds

function onAccountingPacket(session, packet) {
  const currentBytes = packet.input_octets + packet.output_octets;
  const trafficDelta = currentBytes - session.last_bytes;

  if (trafficDelta > ACTIVITY_THRESHOLD) {
    // User is active → pause idle timer
    session.pauseIdleTimer();
  } else {
    // User is idle → increment idle counter
    session.resumeIdleTimer();
  }

  session.last_bytes = currentBytes;
  session.checkExpiry();
  session.checkQuota();
}

// Session expires when:
// 1. Duration exceeded (activity-based time is up)
// 2. Quota exceeded (if package has quota)
// 3. Admin kicks user
// 4. User disconnects manually
```

### 5.2 Device Limit Enforcement

When a user with N max devices attempts to connect:

```
1. Count current online devices
2. If count < max_devices → Allow
3. If count >= max_devices:
   a. Find oldest device (earliest first_seen)
   b. Show admin: "Kicking {device_name} (oldest device)"
   c. Send CoA Disconnect to MikroTik for that device
   d. Mark device as offline
   e. Allow new connection
```

### 5.3 Session States

| State | Description |
|-------|-------------|
| `active` | User connected, timer running |
| `paused` | User idle, timer paused |
| `expiring_soon` | < 5 minutes remaining |
| `expired` | Time/Quota exceeded |
| `kicked` | Admin terminated |
| `disconnected` | User disconnected |

---

## 6. RADIUS Integration

### 6.1 MikroTik Configuration Requirements

```
/radius
  address={server_ip}
  secret={shared_secret}
  service=wireless
  authentication-port=1812
  accounting-port=1813

/radius incoming
  accept=yes
  port=3799
```

### 6.2 RADIUS Attributes

**Access-Accept (Authentication Success):**
| Attribute | Value |
|-----------|-------|
| `Reply-Message` | "Welcome to WiFi Portal" |
| `Session-Timeout` | 3600 (seconds) |
| `Idle-Timeout` | 300 (seconds) |
| `WISPr-Bandwidth-Max-Down` | From package |
| `WISPr-Bandwidth-Max-Up` | From package |
| `WISPr-Quotalimit-Octets-Down` | From package (if quota set) |

**CoA-Request (Change of Authorization):**
| Type | Action |
|------|--------|
| 40 | Disconnect-Request (kick user) |
| 44 | Session-Timeout (change time limit) |
| 36 | Idle-Timeout (change idle timeout) |

### 6.3 CoA Implementation

```javascript
// Send Disconnect to a specific NAS (MikroTik)
async function sendCoADisconnect(sessionId, nasIp) {
  const packet = radiusPacket.create({
    type: 'Disconnect-Request',
    secret: config.radius.secret,
    attributes: {
      'Acct-Session-Id': sessionId,
      'NAS-IP-Address': nasIp
    }
  });

  return sendUDPPacket(nasIp, 3799, packet);
}
```

---

## 7. Captive Portal

### 7.1 Pages

| Page | Route | Description |
|------|-------|-------------|
| Login | `/` | Main login page (local, OAuth, guest) |
| Success | `/success` | After successful login, shows credentials |
| Guest Register | `/guest` | Package selection for guests |
| OAuth Callback | `/auth/google/callback` | Google OAuth handler |
| Logout | `/logout` | Clear session |
| Status | `/status` | Check session status (called by JS) |

### 7.2 Customization Options

| Setting | Type | Description |
|---------|------|-------------|
| `title` | text | Portal title |
| `logo` | file upload | Logo image (PNG/SVG) |
| `background` | file upload | Background image |
| `favicon` | file upload | Favicon |
| `primary_color` | color | Primary brand color |
| `secondary_color` | color | Secondary color |
| `custom_css` | textarea | Additional CSS |
| `custom_js` | textarea | Additional JavaScript |
| `terms_text` | textarea | Terms of service |
| `welcome_message` | textarea | Shown after login |

### 7.3 Portal Assets Structure

```
public/captive-portal/
├── index.html           # Login page
├── success.html         # Success page
├── guest.html           # Guest registration
├── error.html           # Error page
├── assets/
│   ├── css/
│   │   ├── style.css    # Base styles
│   │   └── custom.css   # Admin customizations
│   ├── js/
│   │   ├── app.js       # Main logic
│   │   └── custom.js    # Admin customizations
│   └── images/
│       ├── logo.png     # Default logo
│       └── bg.jpg       # Default background
└── templates/
    └── emails/          # (future: email credentials)
```

---

## 8. Admin Dashboard

### 8.1 Pages

| Page | Path | Description |
|------|------|-------------|
| Login | `/admin/login` | Admin authentication |
| Dashboard | `/admin` | Overview stats |
| Users | `/admin/users` | User management |
| Sessions | `/admin/sessions` | Active sessions |
| Devices | `/admin/devices` | Connected devices |
| Packages | `/admin/packages` | Package management |
| OAuth | `/admin/oauth` | OAuth whitelist management |
| Reports | `/admin/reports` | Analytics & charts |
| Logs | `/admin/logs` | Connection history |
| Settings | `/admin/settings` | System settings |
| Branding | `/admin/branding` | Portal customization |
| Backup | `/admin/backup` | Backup management |

### 8.2 Dashboard Widgets

```
┌─────────────────────────────────────────────────────────────────┐
│  📊 Dashboard                                                     │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐              │
│  │ Online  │ │ Today's │ │ Bandwidth│ │ Active  │              │
│  │  Users  │ │ Sessions│ │  Today  │ │ Sessions│              │
│  │   42    │ │   156   │ │  12.5GB │ │    38   │              │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘              │
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  Active Sessions Table                                 │     │
│  │  User | Device | Duration | BW Down | BW Up | Actions │     │
│  │  ─────────────────────────────────────────────────────│     │
│  │  john | iPhone | 45m      | 2.1 GB   | 120 MB | [Kick] │     │
│  └────────────────────────────────────────────────────────┘     │
│                                                                  │
│  ┌──────────────────────┐  ┌──────────────────────────────┐    │
│  │  Bandwidth (24h)     │  │  Sessions by Type (pie)      │    │
│  │  [line chart]        │  │  [OAuth: 60%]                │    │
│  │                      │  │  [Local: 25%] [Guest: 15%]   │    │
│  └──────────────────────┘  └──────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

### 8.3 User Management

- View all users (filter by type: oauth/local/guest)
- Create local accounts
- Edit user settings (max_devices, is_active)
- View user history
- Delete users
- Add/remove OAuth whitelist entries

### 8.4 OAuth Whitelist Management

```
┌─────────────────────────────────────────────────────────────────┐
│  OAuth Whitelist                                    [+ Add]     │
├─────────────────────────────────────────────────────────────────┤
│  User       │  Allowed Emails          │  Actions              │
│  ─────────────────────────────────────────────────────────────│
│  John D.    │  john@company.com         │  [Edit] [Delete]      │
│             │  john.doe@gmail.com       │                       │
│  Jane S.    │  jane.s@company.com      │  [Edit] [Delete]      │
└─────────────────────────────────────────────────────────────────┘
```

---

## 9. Backup System

### 9.1 Backup Flow

```
1. Trigger: Manual or Scheduled (every 24h)
         │
         ▼
2. SQLite backup via VACUUM INTO
         │
         ▼
3. Compress with gzip
         │
         ▼
4. Upload to WebDAV
   - Path: /wifi-portal/backups/
   - Filename: wifi-portal-{YYYY}-{MM}-{DD}-{HHMMSS}.db.gz
         │
         ▼
5. Log backup status
         │
         ▼
6. Cleanup old backups (keep last N)
```

### 9.2 Restore Flow

```
1. Admin selects backup from list
         │
         ▼
2. Download from WebDAV
         │
         ▼
3. Decompress
         │
         ▼
4. Validate schema
         │
         ▼
5. Backup current database
         │
         ▼
6. Replace with restored version
         │
         ▼
7. Restart application
```

---

## 10. API Endpoints

### 10.1 Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/login` | Admin login |
| POST | `/api/auth/logout` | Admin logout |
| GET | `/api/auth/me` | Get current admin |

### 10.2 User Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/users` | List all users |
| POST | `/api/users` | Create local user |
| GET | `/api/users/:id` | Get user details |
| PUT | `/api/users/:id` | Update user |
| DELETE | `/api/users/:id` | Delete user |
| POST | `/api/users/:id/whitelist` | Add OAuth email |
| DELETE | `/api/users/:id/whitelist/:email` | Remove OAuth email |

### 10.3 Sessions & Devices

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/sessions` | List active sessions |
| GET | `/api/sessions/history` | Session history |
| DELETE | `/api/sessions/:id` | Kick session |
| GET | `/api/devices` | List all devices |
| DELETE | `/api/devices/:mac` | Kick device |

### 10.4 Packages

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/packages` | List packages |
| POST | `/api/packages` | Create package |
| GET | `/api/packages/:id` | Get package |
| PUT | `/api/packages/:id` | Update package |
| DELETE | `/api/packages/:id` | Delete package |

### 10.5 Dashboard & Reports

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/stats/overview` | Dashboard stats |
| GET | `/api/stats/usage` | Usage over time |
| GET | `/api/stats/by-type` | Sessions by type |
| GET | `/api/logs` | Connection logs |
| GET | `/api/logs/export` | Export logs (CSV) |

### 10.6 Settings & Branding

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/settings` | Get all settings |
| PUT | `/api/settings` | Update settings |
| POST | `/api/branding/upload` | Upload asset |
| DELETE | `/api/branding/:id` | Delete asset |
| GET | `/api/branding/assets` | List assets |

### 10.7 Backup

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/backup` | Backup history |
| POST | `/api/backup/now` | Trigger backup |
| POST | `/api/backup/restore/:id` | Restore backup |

---

## 11. Security Considerations

### 11.1 Authentication

- Admin passwords hashed with bcrypt (cost factor 12)
- Session cookies: httpOnly, secure, sameSite: 'strict'
- Rate limiting on login attempts (5/minute per IP)
- Failed login lockout (15 min after 10 failures)

### 11.2 RADIUS Security

- Shared secret stored in environment variable
- All RADIUS packets validated
- Source IP verification for CoA

### 11.3 OAuth Security

- State parameter for CSRF protection
- PKCE for public clients
- Whitelist check before any session creation

### 11.4 Input Validation

- All inputs sanitized
- SQL parameterized queries (no injection)
- XSS prevention in captive portal output

---

## 12. File Structure

```
wifi-portal/
├── src/
│   ├── index.js                 # Entry point
│   ├── app.js                   # Express app setup
│   ├── config/
│   │   └── index.js             # Config loader (.env)
│   ├── routes/
│   │   ├── index.js             # Route aggregator
│   │   ├── auth.js              # Admin auth routes
│   │   ├── admin.js             # Admin SPA routes
│   │   ├── guest.js             # Guest registration
│   │   ├── oauth.js             # Google OAuth
│   │   ├── portal.js            # Captive portal pages
│   │   └── api/
│   │       ├── users.js
│   │       ├── sessions.js
│   │       ├── devices.js
│   │       ├── packages.js
│   │       ├── stats.js
│   │       ├── settings.js
│   │       ├── branding.js
│   │       └── backup.js
│   ├── services/
│   │   ├── authService.js       # Auth logic
│   │   ├── sessionManager.js    # Session lifecycle
│   │   ├── packageManager.js    # Package CRUD
│   │   ├── userManager.js       # User CRUD
│   │   ├── radiusServer.js      # RADIUS/CoA server
│   │   ├── radiusClient.js      # RADIUS client (CoA sender)
│   │   ├── accountingService.js # Accounting processor
│   │   ├── backupService.js     # WebDAV backup
│   │   └── brandingService.js   # Customization
│   ├── middleware/
│   │   ├── auth.js              # Admin auth middleware
│   │   ├── adminOnly.js         # Admin role check
│   │   ├── rateLimit.js         # Rate limiting
│   │   └── errorHandler.js      # Error handling
│   ├── db/
│   │   ├── index.js             # Database connection
│   │   ├── schema.sql           # Database schema
│   │   ├── init.js              # DB initialization
│   │   └── queries/
│   │       ├── users.js
│   │       ├── sessions.js
│   │       ├── packages.js
│   │       └── settings.js
│   └── utils/
│       ├── logger.js             # Winston logger
│       ├── crypto.js             # Password generation
│       └── validators.js         # Input validation
├── public/
│   ├── admin/                   # Admin dashboard (SPA)
│   │   ├── index.html
│   │   ├── css/
│   │   ├── js/
│   │   └── assets/
│   └── captive-portal/          # Captive portal pages
│       ├── index.html
│       ├── success.html
│       ├── guest.html
│       ├── error.html
│       ├── css/
│       ├── js/
│       └── images/
├── scripts/
│   ├── init-db.js               # Initialize database
│   ├── create-admin.js          # Create first admin
│   └── setup-sample-data.js     # Sample packages
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
├── .env.example
├── package.json
├── README.md                    # Setup guide + OAuth instructions
└── SPEC.md                      # This file
```

---

## 13. Dependencies

### 13.1 Production

```json
{
  "express": "^4.18.2",
  "better-sqlite3": "^9.4.0",
  "passport": "^0.7.0",
  "passport-google-oauth20": "^2.0.0",
  "bcryptjs": "^2.4.3",
  "express-session": "^1.17.3",
  "connect-sqlite3": "^0.9.15",
  "multer": "^1.4.5-lts.1",
  "archiver": "^6.0.1",
  "helmet": "^7.1.0",
  "express-rate-limit": "^7.1.5",
  "dotenv": "^16.3.1",
  "winston": "^3.11.0",
  "uuid": "^9.0.1"
}
```

### 13.2 Development

```json
{
  "nodemon": "^3.0.2",
  "jest": "^29.7.0",
  "supertest": "^6.3.3"
}
```

---

## 14. Environment Variables

```bash
# Server
PORT=3000
NODE_ENV=production

# Database
DATABASE_PATH=./data/wifi-portal.db

# Admin
ADMIN_SESSION_SECRET=your-session-secret-min-32-chars

# Google OAuth
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_CALLBACK_URL=https://your-domain.com/auth/google/callback

# RADIUS
RADIUS_SHARED_SECRET=your-radius-secret

# WebDAV Backup
WEBDAV_URL=https://your-nextcloud.com/remote.php/dav/files/username/
WEBDAV_USERNAME=username
WEBDAV_PASSWORD=password
BACKUP_RETENTION=10

# Logging
LOG_LEVEL=info
```

---

## 15. Setup Checklist

### 15.1 Prerequisites

- [ ] Node.js 18+ installed
- [ ] MikroTik configured as RADIUS client
- [ ] Access Points configured for WPA Enterprise
- [ ] Domain DNS pointing to server
- [ ] SSL certificate (Let's Encrypt or purchased)
- [ ] WebDAV server accessible
- [ ] Google Cloud Project created

### 15.2 Installation Steps

1. Clone repository
2. Copy `.env.example` to `.env`
3. Fill in all environment variables
4. Run `npm install`
5. Run `npm run init-db`
6. Run `npm run create-admin`
7. Run `npm run setup-sample-data`
8. Start server: `npm start`

### 15.3 MikroTik Configuration

```routeros
/radius
add address=YOUR_SERVER_IP secret=YOUR_SECRET service=wireless

/radius incoming
set accept=yes port=3799

/interface wireless
set [find name=wlan1] security-profile=guest
/interface wireless security-profile
set guest mode=radius-authentication radius-accounting=yes \
    radius-interim-update=1m \
    authentication-accounting=yes
```

---

## 16. Testing Strategy

### 16.1 Unit Tests

- Auth service (password hashing, verification)
- Session manager (timer logic, quota checking)
- Package manager (validation, calculations)
- Input validators

### 16.2 Integration Tests

- API endpoints
- OAuth flow (mocked)
- RADIUS packet handling
- Database operations

### 16.3 Manual Testing

- Captive portal login flow
- Admin dashboard functionality
- Session expiration
- CoA disconnect
- Backup/restore

---

## 17. Future Considerations (Out of Scope)

- SMS OTP for guest verification
- Payment integration
- Multiple organization support
- LDAP/Active Directory integration
- Mobile app
- Push notifications
- API for third-party integrations

---

## 18. Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2026-08-27 | Claude | Initial spec |
