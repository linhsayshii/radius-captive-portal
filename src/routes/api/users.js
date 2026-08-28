const express = require('express');
const bcrypt = require('bcryptjs');
const { db, users, packages } = require('../../db');
const { requireApiAuth } = require('../../middleware/auth');
const { applyUserPackageSnapshot, revokeUserAuthorizations, flushRadiusOutbox, disconnectActiveAuthorizations } = require('../../services/radiusSync');

const router = express.Router();

function parseOptionalRate(value) {
  if (value === undefined || value === null || value === '') return null;
  const rate = Number(value);
  return Number.isInteger(rate) && rate >= 128 ? rate : undefined;
}

function parseOptionalDuration(value) {
  if (value === undefined || value === null || value === '') return null;
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 1 ? minutes : undefined;
}

function parseOptionalPackageId(value) {
  if (value === undefined || value === null || value === '') return null;
  const packageId = Number(value);
  return Number.isInteger(packageId) && packageId > 0 ? packageId : null;
}

function validateAccessSelection({ packageId, downKbps, upKbps, durationMinutes }) {
  if (downKbps === undefined || upKbps === undefined) return 'Tốc độ riêng phải là số nguyên từ 128 Kbps trở lên.';
  if (durationMinutes === undefined) return 'Thời lượng phải là số phút nguyên lớn hơn 0.';
  if (packageId && !packages.getById.get(packageId)) return 'Gói cước không tồn tại.';
  if (packageId && !packages.getById.get(packageId).is_active) return 'Gói cước đã bị vô hiệu hóa.';
  if (packageId && (downKbps || upKbps)) return 'Chỉ chọn một trong hai: gói cước hoặc tốc độ riêng.';
  if (Boolean(downKbps) !== Boolean(upKbps)) return 'Hãy nhập cả tốc độ tải xuống và tải lên, hoặc chọn không giới hạn.';
  return null;
}

// List users
router.get('/', requireApiAuth, (req, res) => {
  const allUsers = users.getAll.all();
  res.json(allUsers);
});

// Create local user
router.post('/', requireApiAuth, async (req, res) => {
  const { username, password, email, max_devices, package_id, bandwidth_down_kbps, bandwidth_up_kbps, duration_minutes } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const packageId = parseOptionalPackageId(package_id);
  const downKbps = parseOptionalRate(bandwidth_down_kbps);
  const upKbps = parseOptionalRate(bandwidth_up_kbps);
  const durationMinutes = parseOptionalDuration(duration_minutes);
  const accessError = validateAccessSelection({ packageId, downKbps, upKbps, durationMinutes });
  if (accessError) return res.status(400).json({ error: accessError });

  const passwordHash = await bcrypt.hash(password, 12);

  const result = users.create.run({
    type: 'local',
    identifier: username,
    email: email || null,
    password_hash: passwordHash,
    display_name: username,
    max_devices: max_devices || 3,
    package_id: packageId,
    bandwidth_down_kbps: downKbps,
    bandwidth_up_kbps: upKbps,
    duration_minutes: packageId ? null : durationMinutes,
  });

  res.json({ id: result.lastInsertRowid, username });
});

// Update user
router.put('/:id', requireApiAuth, async (req, res) => {
  const user = users.getById.get(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const { email, max_devices, is_active, package_id, bandwidth_down_kbps, bandwidth_up_kbps, duration_minutes } = req.body;

  const nextPackageId = package_id !== undefined ? parseOptionalPackageId(package_id) : user.package_id;
  const nextDownKbps = bandwidth_down_kbps !== undefined ? parseOptionalRate(bandwidth_down_kbps) : user.bandwidth_down_kbps;
  const nextUpKbps = bandwidth_up_kbps !== undefined ? parseOptionalRate(bandwidth_up_kbps) : user.bandwidth_up_kbps;
  const nextDurationMinutes = duration_minutes !== undefined ? parseOptionalDuration(duration_minutes) : user.duration_minutes;
  const accessError = validateAccessSelection({ packageId: nextPackageId, downKbps: nextDownKbps, upKbps: nextUpKbps, durationMinutes: nextDurationMinutes });
  if (accessError) return res.status(400).json({ error: accessError });
  const nextIsActive = is_active !== undefined ? (is_active ? 1 : 0) : user.is_active;
  users.update.run({
    id: req.params.id,
    email: email !== undefined ? email : user.email,
    display_name: user.display_name,
    max_devices: max_devices !== undefined ? max_devices : user.max_devices,
    is_active: nextIsActive,
    package_id: nextPackageId,
    bandwidth_down_kbps: nextPackageId ? null : nextDownKbps,
    bandwidth_up_kbps: nextPackageId ? null : nextUpKbps,
    duration_minutes: nextPackageId ? null : nextDurationMinutes,
  });

  const updatedUser = users.getById.get(req.params.id);

  let affectedMacs = [];
  if (!nextIsActive) {
    affectedMacs = revokeUserAuthorizations(user.id);
  } else if (package_id !== undefined || max_devices !== undefined || bandwidth_down_kbps !== undefined || bandwidth_up_kbps !== undefined || duration_minutes !== undefined) {
    const nextPackage = nextPackageId ? packages.getById.get(nextPackageId) : null;
    if (nextPackageId && !nextPackage?.is_active) {
      affectedMacs = revokeUserAuthorizations(user.id);
    } else {
      affectedMacs = applyUserPackageSnapshot(updatedUser);
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
    const downKbps = parseOptionalRate(user.bandwidth_down_kbps);
    const upKbps = parseOptionalRate(user.bandwidth_up_kbps);
    const durationMinutes = parseOptionalDuration(user.duration_minutes);
    return res.json({
      user_id: user.id,
      has_package: false,
      status: downKbps && upKbps ? 'custom_rate' : 'unlimited',
      message: downKbps && upKbps ? 'Đang dùng tốc độ riêng.' : 'Không gán gói cước và không giới hạn tốc độ.',
      bandwidth_down_kbps: downKbps,
      bandwidth_up_kbps: upKbps,
      duration_minutes: durationMinutes,
      max_devices: user.max_devices,
    });
  }

  const pkg = packages.getById.get(packageId);

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
