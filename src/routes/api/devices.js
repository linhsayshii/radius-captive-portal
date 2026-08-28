const express = require('express');
const { devices, sessions } = require('../../db');
const { requireApiAuth } = require('../../middleware/auth');
const { terminateSession } = require('../../services/sessionManager');
const { getDevicesWithLiveStatus } = require('../../services/deviceStatus');

const router = express.Router();

router.get('/', requireApiAuth, (req, res) => {
  res.json(getDevicesWithLiveStatus());
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
    const result = await terminateSession(activeSession, 'admin_device_kick');
    if (!result.success) {
      return res.status(502).json({
        error: result.error || 'Router chưa xác nhận lệnh ngắt thiết bị',
        disconnect: result.disconnect,
      });
    }
  }

  devices.setOffline.run(normalizedMac);
  devices.setOffline.run(rawMac);
  res.json({ success: true });
});

module.exports = router;
