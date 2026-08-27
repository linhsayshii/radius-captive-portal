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
  const device = devices.getByMac.get(req.params.mac);
  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }

  // Get session and terminate
  if (device.session_id) {
    const session = sessions.getById.get(device.session_id);
    if (session) {
      await terminateSession(session, 'admin');
    }
  }

  devices.setOffline.run(req.params.mac);
  res.json({ success: true });
});

module.exports = router;
