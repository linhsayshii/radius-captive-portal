const express = require('express');
const router = express.Router();
const { packages, users } = require('../../db');
const { requireApiAuth } = require('../../middleware/auth');
const { applyPackageSnapshot, revokePackageAuthorizations, flushRadiusOutbox, disconnectActiveAuthorizations } = require('../../services/radiusSync');

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
router.put('/:id', async (req, res) => {
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

    const updatedPackage = packages.getById.get(req.params.id);
    const affectedMacs = updatedPackage.is_active
      ? applyPackageSnapshot(updatedPackage.id, updatedPackage)
      : revokePackageAuthorizations(updatedPackage.id);
    const sync = await flushRadiusOutbox();
    void disconnectActiveAuthorizations(affectedMacs).catch(() => {});
    if (!updatedPackage.is_active && affectedMacs.length) {
      const { macWhitelist } = require('./guest');
      for (const macAddress of affectedMacs) macWhitelist.delete(macAddress);
    }

    res.json({ message: 'Package updated', affected_authorizations: affectedMacs.length, radius_sync: sync });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update package' });
  }
});

// Delete package
router.delete('/:id', async (req, res) => {
  try {
    const assignedUsers = users.countByPackage.get(req.params.id).count;
    if (assignedUsers) {
      return res.status(409).json({ error: 'Không thể xóa gói đang được gán cho người dùng.', assigned_users: assignedUsers });
    }
    const affectedMacs = revokePackageAuthorizations(req.params.id);
    packages.delete.run(req.params.id);
    const sync = await flushRadiusOutbox();
    void disconnectActiveAuthorizations(affectedMacs).catch(() => {});
    if (affectedMacs.length) {
      const { macWhitelist } = require('./guest');
      for (const macAddress of affectedMacs) macWhitelist.delete(macAddress);
    }
    res.json({ message: 'Package deleted', affected_authorizations: affectedMacs.length, radius_sync: sync });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete package' });
  }
});

module.exports = router;
