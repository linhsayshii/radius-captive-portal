const express = require('express');
const bcrypt = require('bcryptjs');
const { users, oauth } = require('../../db');
const { requireApiAuth } = require('../../middleware/auth');

const router = express.Router();

// List users
router.get('/', requireApiAuth, (req, res) => {
  const allUsers = users.getAll.all();
  res.json(allUsers);
});

// Create local user
router.post('/', requireApiAuth, async (req, res) => {
  const { username, password, email, max_devices, package_id } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const result = users.create.run({
    type: 'local',
    identifier: username,
    email: email || null,
    password_hash: passwordHash,
    display_name: username,
    max_devices: max_devices || 3,
    package_id: package_id ? parseInt(package_id) : null,
  });

  res.json({ id: result.lastInsertRowid, username });
});

// Update user
router.put('/:id', requireApiAuth, (req, res) => {
  const user = users.getById.get(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const { email, max_devices, is_active, package_id } = req.body;

  users.update.run({
    id: req.params.id,
    email: email !== undefined ? email : user.email,
    display_name: user.display_name,
    max_devices: max_devices !== undefined ? max_devices : user.max_devices,
    is_active: is_active !== undefined ? (is_active ? 1 : 0) : user.is_active,
    package_id: package_id !== undefined ? (package_id ? parseInt(package_id) : null) : user.package_id,
  });

  res.json({ success: true });
});

// Delete user
router.delete('/:id', requireApiAuth, (req, res) => {
  users.delete.run(req.params.id);
  res.json({ success: true });
});

// Package status for a specific user
router.get('/:id/package-status', requireApiAuth, (req, res) => {
  const user = users.getById.get(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const packageId = Number.isInteger(Number(user.package_id)) && Number(user.package_id) > 0
    ? Number(user.package_id)
    : null;

  if (!packageId) {
    return res.json({
      user_id: user.id,
      has_package: false,
      status: 'unassigned',
      message: 'Chưa áp dụng gói cước. Sử dụng gói mặc định hệ thống.',
      defaults: {
        duration_seconds: 86400,
        down_kbps: 5000,
        up_kbps: 2000,
        max_devices: 3,
      },
    });
  }

  const pkg = user.package_id ? (require('../db').packages.getById.get(packageId)) : null;

  if (!pkg) {
    return res.json({
      user_id: user.id,
      has_package: false,
      status: 'unassigned',
      message: 'Gói cước không tồn tại hoặc đã bị xóa.',
    });
  }

  return res.json({
    user_id: user.id,
    has_package: true,
    status: pkg.is_active ? 'active' : 'inactive',
    package: {
      id: pkg.id,
      name: pkg.name,
      duration_minutes: pkg.duration_minutes,
      quota_mb: pkg.quota_mb,
      bandwidth_down_kbps: pkg.bandwidth_down_kbps,
      bandwidth_up_kbps: pkg.bandwidth_up_kbps,
      max_devices: pkg.max_devices,
      is_active: pkg.is_active,
    },
  });
});

// List OAuth addresses assigned to an account.
router.get('/:id/whitelist', requireApiAuth, (req, res) => {
  const user = users.getById.get(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json(oauth.getByUser.all(req.params.id));
});

// Add to OAuth whitelist
router.post('/:id/whitelist', requireApiAuth, (req, res) => {
  const { google_email } = req.body;

  if (!google_email) {
    return res.status(400).json({ error: 'Email required' });
  }

  try {
    oauth.create.run({
      user_id: req.params.id,
      google_email,
      allowed_by: req.session.adminId,
    });
    res.json({ success: true });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Email already whitelisted' });
    }
    throw err;
  }
});

// Remove from OAuth whitelist
router.delete('/:id/whitelist/:email', requireApiAuth, (req, res) => {
  const entry = oauth.getByEmail.get(req.params.email);
  if (entry && entry.user_id === parseInt(req.params.id)) {
    oauth.delete.run(entry.id);
  }
  res.json({ success: true });
});

module.exports = router;
