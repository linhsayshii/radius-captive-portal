const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { users, admins } = require('../db');
const { requireApiAuth } = require('../middleware/auth');
const logger = require('../utils/logger');
const { authorizeMac, normalizeMac } = require('./api/guest');

// Admin login page
router.get('/login', (req, res) => {
  if (req.session.adminId) {
    return res.redirect('/admin');
  }
  res.sendFile('admin-login.html', { root: 'public/admin' });
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
    const { username, password, mac_address: macAddress } = req.body;

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

    // The browser has authenticated successfully. Authorise this device MAC so
    // the next Hotspot/RADIUS request from the router is accepted.
    let authorization = null;
    if (macAddress) {
      const mac = normalizeMac(macAddress);
      if (!mac) {
        return res.status(400).json({ error: 'Invalid MAC address' });
      }
      authorization = authorizeMac(mac, {
        user_id: user.id,
        username: user.identifier,
        access_type: 'account',
      });
    }

    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.identifier,
        type: user.type,
      },
      expires_at: authorization?.expires_at || null,
    });
  } catch (err) {
    logger.error('Local login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
