const express = require('express');
const router = express.Router();
const { logs, macAuthorizations } = require('../../db');
const logger = require('../../utils/logger');
const { requireApiAuth } = require('../../middleware/auth');

// MAC authorisations are consumed by RADIUS when the NAS sends an Access-Request.
// Keep the key in canonical form so formats such as AA:BB:CC:DD:EE:FF and
// AA-BB-CC-DD-EE-FF resolve to the same device.
const macWhitelist = new Map();

const { getMacFromIp } = require('../../utils/arp');

// Helper to normalize MAC address
function normalizeMac(mac) {
  if (!mac || typeof mac !== 'string') return null;
  try {
    mac = decodeURIComponent(mac);
  } catch (_) {}
  const normalized = mac.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  return normalized.length === 12 ? normalized : null;
}

// GET /api/guest/client-info
// Returns detected client IP and MAC (via ARP or headers)
router.get('/client-info', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || '';
  const headerMac = req.headers['x-mac-address'] || req.headers['mac-address'] || req.headers['x-client-mac'];
  const queryMac = req.query.mac || req.query.client_mac || req.query.sta_mac;
  const arpMac = getMacFromIp(ip);

  const rawMac = headerMac || queryMac || arpMac;
  const normalized = normalizeMac(rawMac);

  res.json({
    ip,
    mac: normalized || null,
    raw_mac: rawMac || null,
  });
});

// Guest connect - register MAC and allow access
router.post('/connect', async (req, res) => {
  try {
    // Try to get MAC from different sources
    let rawMac = req.body.mac_address;

    // From headers (MikroTik / Aruba / Reverse proxy)
    if (!rawMac || !normalizeMac(rawMac)) {
      rawMac = req.headers['x-mac-address'] || req.headers['mac-address'] || req.headers['x-client-mac'] || req.headers['client-mac'];
    }

    // From query params
    if (!rawMac || !normalizeMac(rawMac)) {
      rawMac = req.query.mac || req.query.client_mac || req.query.clientMac || req.query.sta_mac || req.query.usermac || req.query.user_mac;
    }

    // From ARP table by IP
    if (!rawMac || !normalizeMac(rawMac)) {
      rawMac = getMacFromIp(req.ip || req.socket.remoteAddress);
    }

    const macAddress = normalizeMac(rawMac);
    if (!macAddress) {
      return res.status(400).json({
        error: 'Không nhận diện được địa chỉ MAC thiết bị. Vui lòng mở portal qua trang chuyển hướng của router.',
      });
    }

    // Check if already registered
    if (getAuthorizedMac(macAddress)) {
      logger.info('Guest already connected', { macAddress });
      return res.json({
        success: true,
        message: 'Đã kết nối trước đó',
        mac_address: macAddress,
      });
    }

    // Add to whitelist with expiry (24 hours default)
    const entry = authorizeMac(macAddress, {
      connected_at: new Date().toISOString(),
      ip_address: req.ip,
      user_agent: req.headers['user-agent'],
      access_type: 'instant',
    });

    // Log connection
    logs.create.run({
      user_id: null,
      session_id: macAddress,
      mac_address: macAddress,
      ip_address: req.ip,
      action: 'guest_connect',
      nas_identifier: null,
      details: JSON.stringify({
        user_agent: req.headers['user-agent'],
      }),
    });

    logger.info('Guest connected', { macAddress, ip: req.ip });

    res.json({
      success: true,
      message: 'Kết nối thành công',
      mac_address: macAddress,
      expires_at: entry.expires_at,
    });
  } catch (err) {
    logger.error('Guest connect error:', err);
    res.status(500).json({ error: 'Kết nối thất bại' });
  }
});

// Check if MAC is whitelisted (called by RADIUS)
router.get('/check/:mac', (req, res) => {
  const mac = normalizeMac(req.params.mac);
  const entry = getAuthorizedMac(mac);
  if (!entry) return res.json({ allowed: false });

  res.json({
    allowed: true,
    expires_at: entry.expires_at,
  });
});

// Get whitelist status for admin
router.get('/whitelist', requireApiAuth, (req, res) => {
  res.json(macAuthorizations.getAll.all().map(({ mac_address, ...entry }) => ({ mac: mac_address, ...entry })));
});

// Clear expired entries
router.post('/cleanup', requireApiAuth, (req, res) => {
  const cleared = macAuthorizations.deleteExpired.run().changes;
  for (const [mac, data] of macWhitelist.entries()) {
    if (new Date(data.expires_at) <= new Date()) macWhitelist.delete(mac);
  }
  res.json({ cleared });
});

router.delete('/whitelist/:mac', requireApiAuth, async (req, res) => {
  const mac = normalizeMac(req.params.mac);
  if (!mac || !macAuthorizations.get.get(mac)) {
    return res.status(404).json({ error: 'Không tìm thấy quyền MAC' });
  }
  macWhitelist.delete(mac);
  macAuthorizations.delete.run(mac);

  // Terminate any active session and send RADIUS Disconnect-Request to router immediately
  try {
    const { sessions } = require('../../db');
    const { terminateSession } = require('../../services/sessionManager');
    const activeSession = sessions.getActiveByMac.get(mac, mac);
    if (activeSession) {
      await terminateSession(activeSession, 'admin_revoked_mac');
    }
  } catch (err) {
    logger.error('Error disconnecting revoked MAC session:', err);
  }

  logger.info('MAC authorisation revoked by admin', { macAddress: mac, adminId: req.session.adminId });
  res.json({ success: true });
});

// Helper functions
function authorizeMac(mac, details = {}, durationMs = 24 * 60 * 60 * 1000) {
  const normalized = normalizeMac(mac);
  if (!normalized) throw new Error('Invalid MAC address');

  const entry = {
    ...details,
    connected_at: details.connected_at || new Date().toISOString(),
    expires_at: new Date(Date.now() + durationMs).toISOString(),
  };
  macWhitelist.set(normalized, entry);
  macAuthorizations.upsert.run({
    mac_address: normalized,
    user_id: details.user_id || null,
    username: details.username || null,
    access_type: details.access_type || 'instant',
    connected_at: entry.connected_at,
    expires_at: entry.expires_at,
    ip_address: details.ip_address || null,
    user_agent: details.user_agent || null,
  });
  return entry;
}

function getAuthorizedMac(mac) {
  const normalized = normalizeMac(mac);
  if (!normalized) return null;
  const entry = macWhitelist.get(normalized) || macAuthorizations.get.get(normalized);
  if (!entry) return null;
  if (new Date(entry.expires_at) <= new Date()) {
    macWhitelist.delete(normalized);
    macAuthorizations.delete.run(normalized);
    return null;
  }
  return entry;
}

// Export the router itself so Express can mount it, plus helpers for RADIUS.
module.exports = router;
module.exports.macWhitelist = macWhitelist;
module.exports.normalizeMac = normalizeMac;
module.exports.authorizeMac = authorizeMac;
module.exports.getAuthorizedMac = getAuthorizedMac;
