const dgram = require('dgram');
const crypto = require('crypto');
const { loadConfig } = require('../config');

// RADIUS packet types
const COA_REQUEST = 37;
const DISCONNECT_REQUEST = 40;
const COA_ACK = 44;
const COA_NACK = 45;
const DISCONNECT_ACK = 47;
const DISCONNECT_NACK = 48;

// Attribute types
const ATTR_ACCT_SESSION_ID = 44;
const ATTR_USER_NAME = 1;
const ATTR_WISPR_BANDWIDTH_MAX_DOWN = 231;
const ATTR_WISPR_BANDWIDTH_MAX_UP = 232;
const ATTR_WISPR_QUOTA_LIMIT = 23256;
const ATTR_SESSION_TIMEOUT = 27;
const ATTR_IDLE_TIMEOUT = 28;

// Lazy-load config
let config = null;
function getConfig() {
  if (!config) {
    config = loadConfig();
  }
  return config;
}

let sharedSecret = null;
function getSharedSecret() {
  if (!sharedSecret) {
    sharedSecret = Buffer.from(getConfig().radiusSharedSecret, 'utf8');
  }
  return sharedSecret;
}

function buildCoAPacket(code, id, attrs) {
  // Build CoA-Request or Disconnect-Request packet
  // Header: 20 bytes (Code, ID, Length, Request Authenticator)
  // Request Authenticator is 16 bytes random
  const requestAuth = crypto.randomBytes(16);

  // Calculate packet size
  let attrSize = 0;
  const attrBuffers = [];

  for (const [type, value] of Object.entries(attrs)) {
    let attrType;
    let attrValue;

    switch (type) {
      case 'Acct-Session-Id':
        attrType = ATTR_ACCT_SESSION_ID;
        attrValue = Buffer.from(value, 'utf8');
        break;
      case 'User-Name':
        attrType = ATTR_USER_NAME;
        attrValue = Buffer.from(value, 'utf8');
        break;
      case 'WISPr-Bandwidth-Max-Down':
        attrType = ATTR_WISPR_BANDWIDTH_MAX_DOWN;
        attrValue = Buffer.alloc(4);
        attrValue.writeUInt32BE(value, 0);
        break;
      case 'WISPr-Bandwidth-Max-Up':
        attrType = ATTR_WISPR_BANDWIDTH_MAX_UP;
        attrValue = Buffer.alloc(4);
        attrValue.writeUInt32BE(value, 0);
        break;
      case 'WISPr-Quota-Limit':
        attrType = ATTR_WISPR_QUOTA_LIMIT;
        attrValue = Buffer.alloc(4);
        attrValue.writeUInt32BE(value, 0);
        break;
      case 'Session-Timeout':
        attrType = ATTR_SESSION_TIMEOUT;
        attrValue = Buffer.alloc(4);
        attrValue.writeUInt32BE(value, 0);
        break;
      case 'Idle-Timeout':
        attrType = ATTR_IDLE_TIMEOUT;
        attrValue = Buffer.alloc(4);
        attrValue.writeUInt32BE(value, 0);
        break;
      default:
        continue;
    }

    // Each attribute: Type (1) + Length (1) + Value
    const attrBuf = Buffer.alloc(2 + attrValue.length);
    attrBuf.writeUInt8(attrType, 0);
    attrBuf.writeUInt8(2 + attrValue.length, 1);
    attrValue.copy(attrBuf, 2);
    attrBuffers.push(attrBuf);
    attrSize += 2 + attrValue.length;
  }

  // Total packet size
  const packetSize = 20 + attrSize;
  const packet = Buffer.alloc(packetSize);

  // Write header
  packet.writeUInt8(code, 0);
  packet.writeUInt8(id, 1);
  packet.writeUInt16BE(packetSize, 2);
  requestAuth.copy(packet, 4);

  // Write attributes
  let offset = 20;
  for (const attrBuf of attrBuffers) {
    attrBuf.copy(packet, offset);
    offset += attrBuf.length;
  }

  // Calculate response authenticator
  // For CoA/Disconnect: Response = MD5(Code + ID + Length + RequestAuth + Attributes + Secret)
  const responseAuth = crypto.createHash('md5')
    .update(Buffer.concat([packet, getSharedSecret()]))
    .digest();

  // For now, use the request authenticator in the packet
  // In a real implementation, you'd wait for the response and verify it

  return packet;
}

async function sendCoA(nasIp, attributes) {
  return new Promise((resolve, reject) => {
    const client = dgram.createSocket('udp4');
    const id = Math.floor(Math.random() * 256);

    // Build CoA-Request packet
    const packet = buildCoAPacket(COA_REQUEST, id, attributes);

    const timeout = setTimeout(() => {
      client.close();
      reject(new Error('CoA timeout'));
    }, 5000);

    client.on('message', (msg) => {
      clearTimeout(timeout);
      const code = msg.readUInt8(0);
      client.close();

      if (code === COA_ACK) {
        resolve({ success: true });
      } else if (code === COA_NACK) {
        resolve({ success: false, error: 'CoA rejected by NAS' });
      } else {
        resolve({ success: false, error: `Unknown response code: ${code}` });
      }
    });

    client.on('error', (err) => {
      clearTimeout(timeout);
      client.close();
      reject(err);
    });

    client.send(packet, getConfig().radiusCoaPort, nasIp, (err) => {
      if (err) {
        clearTimeout(timeout);
        client.close();
        reject(err);
      }
    });
  });
}

async function disconnectSession(sessionId, nasIp) {
  return new Promise((resolve, reject) => {
    const client = dgram.createSocket('udp4');
    const id = Math.floor(Math.random() * 256);

    // Build Disconnect-Request packet
    const packet = buildCoAPacket(DISCONNECT_REQUEST, id, {
      'Acct-Session-Id': sessionId,
    });

    const timeout = setTimeout(() => {
      client.close();
      reject(new Error('Disconnect timeout'));
    }, 5000);

    client.on('message', (msg) => {
      clearTimeout(timeout);
      const code = msg.readUInt8(0);
      client.close();

      if (code === DISCONNECT_ACK) {
        resolve({ success: true });
      } else if (code === DISCONNECT_NACK) {
        resolve({ success: false, error: 'Disconnect rejected by NAS' });
      } else {
        resolve({ success: false, error: `Unknown response code: ${code}` });
      }
    });

    client.on('error', (err) => {
      clearTimeout(timeout);
      client.close();
      reject(err);
    });

    client.send(packet, getConfig().radiusCoaPort, nasIp, (err) => {
      if (err) {
        clearTimeout(timeout);
        client.close();
        reject(err);
      }
    });
  });
}

async function changeBandwidth(sessionId, nasIp, downKbps, upKbps) {
  return sendCoA(nasIp, {
    'Acct-Session-Id': sessionId,
    'WISPr-Bandwidth-Max-Down': downKbps * 1000, // Convert Kbps to bps
    'WISPr-Bandwidth-Max-Up': upKbps * 1000,    // Convert Kbps to bps
  });
}

async function applyQuota(sessionId, nasIp, quotaMb) {
  return sendCoA(nasIp, {
    'Acct-Session-Id': sessionId,
    'WISPr-Quota-Limit': quotaMb * 1024, // Convert MB to KB
  });
}

module.exports = { sendCoA, disconnectSession, changeBandwidth, applyQuota };
