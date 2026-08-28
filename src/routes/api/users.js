const express = require('express');
const bcrypt = require('bcryptjs');
const { db, users, packages } = require('../../db');
const { requireApiAuth } = require('../../middleware/auth');
const { applyUserPackageSnapshot, revokeUserAuthorizations, flushRadiusOutbox, disconnectActiveAuthorizations } = require('../../services/radiusSync');

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
router.put('/:id', requireApiAuth, async (req, res) => {
  const user = users.getById.get(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const { email, max_devices, is_active, package_id } = req.body;

  const nextPackageId = package_id !== undefined ? (package_id ? parseInt(package_id) : null) : user.package_id;
  const nextIsActive = is_active !== undefined ? (is_active ? 1 : 0) : user.is_active;
  users.update.run({
    id: req.params.id,
    email: email !== undefined ? email : user.email,
    display_name: user.display_name,
    max_devices: max_devices !== undefined ? max_devices : user.max_devices,
    is_active: nextIsActive,
    package_id: nextPackageId,
  });

  let affectedMacs = [];
  if (!nextIsActive) {
    affectedMacs = revokeUserAuthorizations(user.id);
  } else if (package_id !== undefined || max_devices !== undefined) {
    const nextPackage = nextPackageId ? packages.getById.get(nextPackageId) : null;
    if (nextPackageId && !nextPackage?.is_active) {
      affectedMacs = revokeUserAuthorizations(user.id);
    } else {
      affectedMacs = applyUserPackageSnapshot(user.id, nextPackage, max_devices !== undefined ? max_devices : user.max_devices);
    }
  }
  const sync = affectedMacs.length ? await flushRadiusOutbox() : { processed: 0, failed: 0, pending: 0 };
  void disconnectActiveAuthorizations(affectedMacs).catch(() => {});
  if (affectedMacs.length && (!nextIsActive || (nextPackageId && !packages.getById.get(nextPackageId)?.is_active))) {
    const { macWhitelist } = require('./guest');
    for (const macAddress of affectedMacs) macWhitelist.delete(macAddress);
  }

  res.json({ success: true, affected_authorizations: affectedMacs.length, radius_sync: sync });
});

// Delete user
router.delete('/:id', requireApiAuth, async (req, res) => {
  const user = users.getById.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const affectedMacs = revokeUserAuthorizations(user.id);
  db.transaction(() => {
    db.prepare('DELETE FROM oauth_whitelist WHERE user_id = ?').run(user.id);
    db.prepare('UPDATE sessions SET user_id = NULL WHERE user_id = ?').run(user.id);
    db.prepare('UPDATE devices SET user_id = NULL WHERE user_id = ?').run(user.id);
    users.delete.run(user.id);
  })();
  const { macWhitelist } = require('./guest');
  for (const macAddress of affectedMacs) macWhitelist.delete(macAddress);
  const sync = await flushRadiusOutbox();
  void disconnectActiveAuthorizations(affectedMacs).catch(() => {});
  res.json({ success: true, affected_authorizations: affectedMacs.length, radius_sync: sync });
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

module.exports = router;
