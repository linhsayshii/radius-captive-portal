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
