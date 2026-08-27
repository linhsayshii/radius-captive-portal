const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { loadConfig } = require('./config');
const { passport } = require('./routes/oauth');
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
let sessionStore;
try {
  const SQLiteStore = require('connect-sqlite3')(session);
  sessionStore = new SQLiteStore({
    db: 'sessions.db',
    dir: path.dirname(config.databasePath),
  });
} catch (err) {
  logger.warn('SQLiteStore not initialized, falling back to default session store: ' + err.message);
}

// Session configuration
const sessionConfig = {
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
};
if (sessionStore) {
  sessionConfig.store = sessionStore;
}

app.use(session(sessionConfig));

// Passport initialization
app.use(passport.initialize());
app.use(passport.session());

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
app.use('/', require('./routes'));
app.use('/auth', require('./routes/auth'));
app.use('/auth', require('./routes/oauth').router);
app.use('/admin', require('./routes/auth')); // Admin auth routes
app.use('/admin/api', require('./routes/admin'));
app.use('/admin/api', require('./routes/admin/stats'));
app.use('/admin/api/settings', require('./routes/api/settings'));
app.use('/api/packages', require('./routes/api/packages'));
app.use('/api/guest', require('./routes/api/guest'));
app.use('/api/users', require('./routes/api/users'));
app.use('/api/sessions', require('./routes/api/sessions'));
app.use('/api/devices', require('./routes/api/devices'));
app.use('/api', require('./routes/api'));

// Error handler
app.use(errorHandler);

module.exports = app;
