const express = require('express');
const { devices, sessions, db } = require('../../db');
const { requireApiAuth } = require('../../middleware/auth');
const { terminateSession } = require('../../services/sessionManager');

const router = express.Router();

router.get('/', requireApiAuth, (req, res) => {
  const allDevices = db.prepare(`
    SELECT d.*, s.username
    FROM devices d
    LEFT JOIN sessions s ON d.session_id = s.id
    ORDER BY d.last_seen DESC
  `).all();
  res.json(allDevices);
});

router.delete('/:mac', requireApiAuth, async (req, res) => {
  const { normalizeMac } = require('./guest');
  const rawMac = req.params.mac;
  const normalizedMac = normalizeMac(rawMac) || rawMac;

  const device = devices.getByMac.get(normalizedMac) || devices.getByMac.get(rawMac);
  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }

  // Find active session for device and terminate with RADIUS Disconnect-Request
  const activeSession = sessions.getActiveByMac.get(normalizedMac, normalizedMac) ||
    (device.session_id ? sessions.getById.get(device.session_id) : null);

  if (activeSession && activeSession.is_active) {
    await terminateSession(activeSession, 'admin_device_kick');
  }

  devices.setOffline.run(normalizedMac);
  devices.setOffline.run(rawMac);
  res.json({ success: true });
});

module.exports = router;
