# WiFi Captive Portal & RADIUS Server

## What is this?

Full-stack captive portal solution for schools/companies with WiFi networks. Provides:
- **Captive Portal UI** — Guest login (instant access, local accounts, Google OAuth)
- **Admin Dashboard** — React SPA for managing users, sessions, devices, packages, OAuth whitelist, backups, settings
- **Custom RADIUS Server** — UDP, RFC 2865/2866 compliant (Auth on 1812, Accounting on 1813)
- **RADIUS CoA/Disconnect Client** — RFC 5176 (port 3799) for kicking sessions
- **Session Management** — Idle tracking, quota enforcement, device limits, live bandwidth metrics
- **SQLite Database** — Users, sessions, devices, packages, settings, OAuth whitelist, MAC authorizations, backups
- **WebDAV Backup** — Compress + upload SQLite dumps

## Tech Stack

**Backend:** Node.js, CommonJS, Express, better-sqlite3, passport + passport-google-oauth20, bcryptjs, express-session, helmet, express-rate-limit, winston

**Frontend:** Vite 8, React 19, TypeScript, Tailwind CSS v4, shadcn/ui (manually managed, `base-nova` style), Base UI (`@base-ui/react`), lucide-react, Geist font

## Project Structure

```
src/
├── index.js              # Entry: bootstraps HTTP + RADIUS servers
├── app.js               # Express app (middleware, routes, static files)
├── config/index.js       # dotenv config loader
├── db/
│   ├── index.js         # DB connection + prepared SQL statements
│   └── schema.sql       # Full schema (migrations via IF NOT EXISTS)
├── routes/
│   ├── auth.js           # Admin login/logout/me + local user auth
│   ├── oauth.js          # Google OAuth 2.0
│   ├── admin.js          # Admin API sub-router
│   ├── admin/stats.js    # GET /admin/api/stats
│   ├── admin/backup.js   # POST /admin/api/backup
│   └── api/
│       ├── users.js      # User CRUD + OAuth whitelist
│       ├── sessions.js   # Active sessions + history + kick
│       ├── devices.js    # Device registry
│       ├── packages.js   # Bandwidth package CRUD
│       ├── guest.js      # MAC authorization
│       └── settings.js   # Settings + RADIUS/OAuth diagnostics
├── services/
│   ├── radiusServer.js   # RADIUS Auth (UDP 1812) + Accounting (UDP 1813)
│   ├── radiusClient.js   # CoA/Disconnect sender (UDP 3799)
│   ├── sessionManager.js # Idle checker, session termination, live metrics
│   ├── accessPolicy.js   # Resolves bandwidth/duration/quota from user package
│   ├── sqliteSessionStore.js
│   ├── backup.js         # WebDAV backup
│   └── arp.js            # ARP table lookup for MAC resolution
├── middleware/
│   ├── auth.js           # requireAuth / requireApiAuth
│   ├── rateLimiter.js    # Three rate limiters (auth/guest/api)
│   └── errorHandler.js
├── utils/
│   └── logger.js        # Winston logger
├── portal/               # Captive portal React SPA
└── admin/                # Admin dashboard React SPA

scripts/
├── init-db.js           # Create DB + schema + default settings
├── create-admin.js      # Create first admin account
├── setup-sample-data.js  # Sample bandwidth packages
├── reset-admin.js       # Reset admin password
├── test-radius-workflow.js
└── test-rate-limits.js

public/
├── captive-portal/      # Built portal SPA (HTML + JS + CSS + fonts)
└── admin/               # Built admin SPA (HTML + JS + CSS + fonts)

data/
└── wifi-portal.db       # SQLite database

docs/
├── mikrotik-radius-hotspot.md
└── aruba-instant-radius-setup.md
```

## Key Architecture Notes

- **Two separate Vite builds** — Portal SPA and Admin SPA built independently to `public/captive-portal/` and `public/admin/`, both served as static files by Express.
- **Custom RADIUS server** — Built with Node's `dgram` (UDP) module, no freeradius or similar.
- **MAC authorization bridge** — Portal authorizes a device MAC after login; RADIUS verifies it on the next Access-Request from the router. Enables both instant-guest and credentialed flows.
- **Access policy** centralized in `services/accessPolicy.js` — consumed by portal auth, RADIUS server, and session manager for consistent limits.
- **Backend is CommonJS** (`require()`), **frontend is ESM** (`import/export`).
- **UI text is primarily in Vietnamese.**

## Commands

```bash
# Setup
cp .env.example .env          # Fill in secrets first
npm install
npm run init-db              # Create DB + tables + default settings
npm run create-admin         # Interactive: create first admin account
npm run setup-sample-data    # Optional: sample bandwidth packages

# Development
npm run dev                  # nodemon: HTTP :3000 + RADIUS UDP :1812/:1813
npm run dev:portal           # Vite dev server for portal (proxies /api to :3000)
npm run dev:admin           # Vite dev server for admin (proxies /api to :3000)

# Build
npm run build:portal         # Build portal → public/captive-portal/
npm run build:admin          # Build admin → public/admin/

# Type check
npm run check:portal         # tsc --project tsconfig.app.json

# Production
npm start                    # HTTP :3000 + RADIUS :1812/:1813
```

## Key Files

- `SPEC.md` — Full system specification (architecture, data model, flows, API, security)
- `README.md` — Setup guide in Vietnamese + router config snippets
- `docs/mikrotik-radius-hotspot.md` — MikroTik RouterOS configuration guide
- `docs/aruba-instant-radius-setup.md` — Aruba Instant AP configuration guide
- `src/config/index.js` — Environment variables reference
- `src/db/schema.sql` — Complete SQL schema
