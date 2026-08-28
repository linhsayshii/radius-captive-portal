const dotenv = require('dotenv');
const path = require('path');

// Load .env file
dotenv.config();

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

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
    radiusAuthPort: parseInt(process.env.RADIUS_AUTH_PORT || '1812', 10),
    radiusAccountingPort: parseInt(process.env.RADIUS_ACCOUNTING_PORT || '1813', 10),
    radiusCoaPort: parseInt(process.env.RADIUS_COA_PORT || '3799', 10),
    radiusClients: parseCsv(process.env.RADIUS_CLIENTS),
    // FreeRADIUS policy store. This is deliberately separate from the portal
    // SQLite database: FreeRADIUS uses MySQL/MariaDB through rlm_sql.
    radiusDatabaseUrl: process.env.RADIUS_DATABASE_URL || '',
    // WebDAV
    webdavUrl: process.env.WEBDAV_URL || '',
    webdavUsername: process.env.WEBDAV_USERNAME || '',
    webdavPassword: process.env.WEBDAV_PASSWORD || '',
    backupRetention: parseInt(process.env.BACKUP_RETENTION || '10', 10),
    // Rate Limiting & Proxy
    trustProxy: process.env.TRUST_PROXY ? (process.env.TRUST_PROXY === 'true' ? true : process.env.TRUST_PROXY) : 1,
    rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || String(15 * 60 * 1000), 10),
    rateLimitApiMax: parseInt(process.env.RATE_LIMIT_API_MAX || '1200', 10),
    rateLimitAuthMax: parseInt(process.env.RATE_LIMIT_AUTH_MAX || '20', 10),
    rateLimitGuestMax: parseInt(process.env.RATE_LIMIT_GUEST_MAX || '60', 10),
  };
}

module.exports = { loadConfig };
