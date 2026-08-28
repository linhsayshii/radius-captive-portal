const express = require('express');
const os = require('os');
const { loadConfig } = require('../../config');
const { requireApiAuth } = require('../../middleware/auth');

const router = express.Router();

router.use(requireApiAuth);

function getPrimaryLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return null;
}

/**
 * GET /admin/api/settings
 * Returns current configuration status (secrets masked)
 */
router.get('/', (req, res) => {
  const config = loadConfig();
  const detectedLanIp = process.env.PORTAL_SERVER_IP || getPrimaryLanIp() ||
    (req.hostname && req.hostname !== 'localhost' && req.hostname !== '127.0.0.1' ? req.hostname : '127.0.0.1');
  const protocol = req.protocol || 'http';
  const portSuffix = config.port === 80 || config.port === 443 ? '' : `:${config.port}`;
  const portalUrl = `${protocol}://${detectedLanIp}${portSuffix}`;

  res.json({
    radius: {
      sharedSecretConfigured: Boolean(config.radiusSharedSecret && config.radiusSharedSecret !== 'changeme'),
      authPort: config.radiusAuthPort,
      accountingPort: config.radiusAccountingPort,
      coaPort: config.radiusCoaPort,
      serverIp: detectedLanIp,
    },
    portalUrl,
    oauth: {
      clientIdConfigured: Boolean(config.googleClientId),
      callbackUrl: config.googleCallbackUrl,
    },
  });
});

/**
 * POST /admin/api/settings/test-radius
 * Performs genuine diagnostics:
 * 1. Tests local RADIUS server health (UDP 1812)
 * 2. Tests Router CoA / Disconnect port (UDP 3799) if routerIp is provided
 */
router.post('/test-radius', async (req, res) => {
  const config = loadConfig();
  const { routerIp, sharedSecret, coaPort, authPort } = req.body;
  const secret = sharedSecret || config.radiusSharedSecret;
  const targetAuthPort = parseInt(authPort, 10) || config.radiusAuthPort || 1812;
  const targetCoaPort = parseInt(coaPort, 10) || config.radiusCoaPort || 3799;

  if (!secret) {
    return res.status(400).json({
      success: false,
      message: 'Thiếu Shared Secret để kiểm tra RADIUS',
    });
  }

  const dgram = require('dgram');
  const crypto = require('crypto');
  const { buildRfc5176Packet, DISCONNECT_REQUEST, DISCONNECT_ACK, DISCONNECT_NACK } = require('../../services/radiusClient');

  // Step 1: Test local RADIUS server (UDP 1812)
  let localServerOk = false;
  try {
    const localSocket = dgram.createSocket('udp4');
    const testId = Math.floor(Math.random() * 256);
    const reqAuth = crypto.randomBytes(16);
    const testUser = Buffer.from('connectivity-check');
    const attrBuf = Buffer.concat([
      Buffer.from([1, 2 + testUser.length]),
      testUser,
    ]);

    const header = Buffer.alloc(20);
    header.writeUInt8(1, 0); // Access-Request
    header.writeUInt8(testId, 1);
    header.writeUInt16BE(20 + attrBuf.length, 2);
    reqAuth.copy(header, 4);

    const packet = Buffer.concat([header, attrBuf]);

    localServerOk = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { localSocket.close(); } catch (_) {}
        resolve(false);
      }, 1500);

      localSocket.on('message', (msg) => {
        clearTimeout(timer);
        try { localSocket.close(); } catch (_) {}
        resolve(msg.length >= 20);
      });

      localSocket.on('error', () => {
        clearTimeout(timer);
        try { localSocket.close(); } catch (_) {}
        resolve(false);
      });

      localSocket.send(packet, targetAuthPort, '127.0.0.1', (err) => {
        if (err) {
          clearTimeout(timer);
          try { localSocket.close(); } catch (_) {}
          resolve(false);
        }
      });
    });
  } catch (err) {
    localServerOk = false;
  }

  // Step 2: If router IP is provided, test Router Incoming CoA / Disconnect (UDP 3799)
  if (routerIp && routerIp !== '127.0.0.1' && routerIp !== 'localhost') {
    try {
      const coaSocket = dgram.createSocket('udp4');
      const id = Math.floor(Math.random() * 256);
      const { packet: coaPacket } = buildRfc5176Packet(DISCONNECT_REQUEST, id, {
        'Acct-Session-Id': 'test-connectivity-probe',
        'User-Name': 'test-probe',
      });

      const coaResult = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { coaSocket.close(); } catch (_) {}
          resolve({
            responded: false,
            message: `Máy chủ RADIUS nội bộ (Port ${targetAuthPort}) hoạt động tốt. Tuy nhiên Router (${routerIp}) không phản hồi cổng CoA UDP ${targetCoaPort}. Hãy kiểm tra xem trên Router đã chạy lệnh '/radius incoming set accept=yes port=${targetCoaPort}' và mở tường lửa chưa.`,
          });
        }, 3000);

        coaSocket.on('message', (msg) => {
          clearTimeout(timer);
          try { coaSocket.close(); } catch (_) {}
          const code = msg.readUInt8(0);
          if (code === DISCONNECT_ACK || code === DISCONNECT_NACK || code === 44 || code === 45) {
            resolve({
              responded: true,
              message: `Kết nối hoàn hảo! Router (${routerIp}) đã phản hồi cổng CoA UDP ${targetCoaPort} và máy chủ RADIUS (Port ${targetAuthPort}) hoạt động bình thường.`,
            });
          } else {
            resolve({
              responded: true,
              message: `Router (${routerIp}) đã phản hồi với mã Code: ${code}.`,
            });
          }
        });

        coaSocket.on('error', (err) => {
          clearTimeout(timer);
          try { coaSocket.close(); } catch (_) {}
          resolve({ responded: false, message: `Lỗi kết nối UDP tới Router: ${err.message}` });
        });

        coaSocket.send(coaPacket, targetCoaPort, routerIp, (err) => {
          if (err) {
            clearTimeout(timer);
            try { coaSocket.close(); } catch (_) {}
            resolve({ responded: false, message: `Không thể gửi gói tin tới ${routerIp}:${targetCoaPort} - ${err.message}` });
          }
        });
      });

      return res.json({
        success: coaResult.responded,
        localServerRunning: localServerOk,
        message: coaResult.message,
      });
    } catch (err) {
      return res.status(500).json({
        success: false,
        message: `Lỗi kiểm tra router: ${err.message}`,
      });
    }
  }

  // If only testing local server
  if (localServerOk) {
    return res.json({
      success: true,
      localServerRunning: true,
      message: `Máy chủ RADIUS đang lắng nghe và phản hồi tốt trên cổng UDP ${targetAuthPort}. (Nhập thêm Router IP để test cổng ngắt kết nối CoA UDP ${targetCoaPort} trên Router).`,
    });
  } else {
    return res.json({
      success: false,
      localServerRunning: false,
      message: `Máy chủ RADIUS chưa phản hồi trên cổng UDP ${targetAuthPort}. Hãy kiểm tra xem server đã khởi động cổng RADIUS chưa.`,
    });
  }
});

/**
 * POST /admin/api/settings/test-oauth
 * Test OAuth configuration by checking if credentials are set
 */
router.post('/test-oauth', async (_req, res) => {
  const config = loadConfig();

  if (!config.googleClientId || !config.googleClientSecret) {
    return res.json({
      success: false,
      configured: false,
      message: 'Google OAuth chưa được cấu hình. Vui lòng thiết lập GOOGLE_CLIENT_ID và GOOGLE_CLIENT_SECRET trong .env',
    });
  }

  if (!config.googleCallbackUrl) {
    return res.json({
      success: false,
      configured: false,
      message: 'Google OAuth callback URL chưa được cấu hình',
    });
  }

  // Validate URL format
  try {
    new URL(config.googleCallbackUrl);
  } catch {
    return res.json({
      success: false,
      configured: true,
      message: 'GOOGLE_CALLBACK_URL không hợp lệ',
    });
  }

  // Check if client ID looks valid (basic format check)
  if (!config.googleClientId.includes('.apps.googleusercontent.com')) {
    return res.json({
      success: false,
      configured: true,
      message: 'GOOGLE_CLIENT_ID có thể không đúng định dạng (nên kết thúc bằng .apps.googleusercontent.com)',
    });
  }

  res.json({
    success: true,
    configured: true,
    message: 'Google OAuth đã được cấu hình đúng. Callback URL: ' + config.googleCallbackUrl,
    callbackUrl: config.googleCallbackUrl,
  });
});

module.exports = router;
