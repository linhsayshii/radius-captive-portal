const express = require('express');
const router = express.Router();
const { packages } = require('../../db');
const { requireApiAuth } = require('../../middleware/auth');

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
router.put('/:id', (req, res) => {
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

    res.json({ message: 'Package updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update package' });
  }
});

// Delete package
router.delete('/:id', (req, res) => {
  try {
    packages.delete.run(req.params.id);
    res.json({ message: 'Package deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete package' });
  }
});

module.exports = router;
