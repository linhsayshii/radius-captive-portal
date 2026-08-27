const express = require('express');
const { loadConfig } = require('../../config');

const router = express.Router();

/**
 * GET /admin/api/settings
 * Returns current configuration status (secrets masked)
 */
router.get('/', (_req, res) => {
  const config = loadConfig();

  res.json({
    radius: {
      sharedSecretConfigured: Boolean(config.radiusSharedSecret && config.radiusSharedSecret !== 'changeme'),
      authPort: config.radiusAuthPort,
      accountingPort: config.radiusAccountingPort,
      coaPort: config.radiusCoaPort,
    },
    oauth: {
      clientIdConfigured: Boolean(config.googleClientId),
      callbackUrl: config.googleCallbackUrl,
    },
  });
});

/**
 * POST /admin/api/settings/test-radius
 * Test RADIUS connectivity by sending an Access-Request
 */
router.post('/test-radius', async (req, res) => {
  const config = loadConfig();
  const { routerIp, sharedSecret, authPort } = req.body;

  if (!routerIp || !sharedSecret) {
    return res.status(400).json({
      success: false,
      message: 'Thiếu thông tin router IP hoặc shared secret',
    });
  }

  try {
    const dgram = require('dgram');
    const crypto = require('crypto');

    const socket = dgram.createSocket('udp4');
    const testUsername = 'test-connectivity-' + Date.now();
    const packetId = Math.floor(Math.random() * 256);
    const requestAuth = crypto.randomBytes(16);

    // Build Access-Request packet
    const message = Buffer.from(testUsername);
    const userPassword = Buffer.alloc(16);
    Buffer.from('test').copy(userPassword);

    // Simple password encoding for testing
    const encodedPassword = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) {
      const hash = crypto.createHash('md5')
        .update(Buffer.concat([Buffer.from(sharedSecret, 'utf8'), requestAuth]))
        .digest();
      encodedPassword[i] = userPassword[i] ^ hash[i];
    }

    // Build packet attributes
    const attrs = [];
    // User-Name (1)
    attrs.push(Buffer.from([1, 2 + message.length, ...message]));
    // User-Password (2)
    attrs.push(Buffer.from([2, 18, ...encodedPassword]));
    // NAS-IP-Address (4)
    const nasIp = Buffer.alloc(4);
    nasIp.writeUInt32BE(0, 0); // 0.0.0.0 as we are the client
    attrs.push(Buffer.from([4, 6, ...nasIp]));

    const attrBuffer = Buffer.concat(attrs);

    // Build packet header
    const header = Buffer.alloc(20);
    header.writeUInt8(1, 0); // Access-Request
    header.writeUInt8(packetId, 1);

    const body = Buffer.concat([requestAuth, attrBuffer]);
    header.writeUInt16BE(20 + attrBuffer.length, 2);
    header.writeUInt8(0); // placeholder for auth

    const packet = Buffer.concat([header, attrBuffer]);

    // Compute authenticator
    const authenticator = crypto.createHash('md5')
      .update(Buffer.concat([packet, Buffer.from(sharedSecret, 'utf8')]))
      .digest();
    packet.writeUInt8(0, 4);
    authenticator.copy(packet, 4);

    const targetPort = authPort || config.radiusAuthPort;

    const result = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        socket.close();
        resolve({ success: false, message: 'Timeout - Router không phản hồi' });
      }, 5000);

      socket.on('message', (msg, _rinfo) => {
        clearTimeout(timeout);
        socket.close();
        const code = msg.readUInt8(0);
        if (code === 2) {
          resolve({ success: true, message: 'Kết nối thành công - Router chấp nhận Access-Request' });
        } else if (code === 3) {
          resolve({ success: true, message: 'Kết nối thành công - Router từ chối (Access-Reject) - Điều này là bình thường khi test' });
        } else {
          resolve({ success: true, message: `Router phản hồi với mã: ${code}` });
        }
      });

      socket.on('error', (err) => {
        clearTimeout(timeout);
        socket.close();
        resolve({ success: false, message: `Lỗi kết nối: ${err.message}` });
      });

      socket.send(packet, targetPort, routerIp, (err) => {
        if (err) {
          clearTimeout(timeout);
          socket.close();
          resolve({ success: false, message: `Lỗi gửi packet: ${err.message}` });
        }
      });
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `Lỗi: ${error.message}`,
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
