const dgram = require('dgram');
const crypto = require('crypto');
const { loadConfig } = require('../config');
const { sessions, devices, users, packages, logs } = require('../db');
const { startIdleChecker, stopIdleChecker, updateSessionActivity, handleNewConnection } = require('./sessionManager');

const config = loadConfig();

// RADIUS packet types
const PACKET_ACCESS_REQUEST = 1;
const PACKET_ACCESS_ACCEPT = 2;
const PACKET_ACCESS_REJECT = 3;
const PACKET_ACCOUNTING_REQUEST = 4;
const PACKET_ACCOUNTING_RESPONSE = 5;
const PACKET_ACCESS_CHALLENGE = 11;

// RADIUS attribute types
const ATTR_USER_NAME = 1;
const ATTR_USER_PASSWORD = 2;
const ATTR_REPLY_MESSAGE = 18;
const ATTR_SESSION_TIMEOUT = 27;
const ATTR_NAS_IP = 4;
const ATTR_NAS_PORT = 5;
const ATTR_SERVICE_TYPE = 6;
const ATTR_FRAMED_IP = 8;
const ATTR_ACCT_STATUS_TYPE = 40;
const ATTR_ACCT_SESSION_ID = 44;
const ATTR_ACCT_INPUT_OCTETS = 42;
const ATTR_ACCT_OUTPUT_OCTETS = 43;
const ATTR_ACCT_SESSION_TIME = 46;
const ATTR_ACCT_TERMINATE_CAUSE = 49;
const ATTR_VENDOR_SPECIFIC = 26;

// Accounting status types
const ACCT_STATUS_START = 1;
const ACCT_STATUS_STOP = 2;
const ACCT_STATUS_UPDATE = 3;
const ACCT_STATUS_INTERIM = 3;

// NAS shared secret
const sharedSecret = Buffer.from(config.radiusSharedSecret || 'sharedsecret', 'utf8');

// Server instance
let servers = [];

function parsePacket(buffer) {
  if (buffer.length < 20) return null;

  const code = buffer.readUInt8(0);
  const id = buffer.readUInt8(1);
  const length = buffer.readUInt16BE(2);
  const authenticator = buffer.subarray(4, 20);
  const attributes = parseAttributes(buffer.subarray(20));

  return { code, id, length, authenticator, attributes };
}

function parseAttributes(buffer) {
  const attrs = {};
  let offset = 0;

  while (offset < buffer.length) {
    const type = buffer.readUInt8(offset);
    const len = buffer.readUInt8(offset + 1);

    if (len < 2 || offset + len > buffer.length) break;

    const value = buffer.subarray(offset + 2, offset + len);

    if (!attrs[type]) attrs[type] = [];
    attrs[type].push(value);

    offset += len;
  }

  return attrs;
}

function buildResponse(requestCode, requestId, requestAuth, attributes, requestPacket) {
  const code = requestCode;
  const id = requestId;
  const attrBuffer = buildAttributes(attributes);

  // Response authenticator = MD5(Code + ID + Length + RequestAuth + Attributes + Secret)
  const lengthPlaceholder = Buffer.alloc(2);
  const placeholderAuth = Buffer.alloc(16);
  const header = Buffer.concat([Buffer.from([code]), Buffer.from([id]), lengthPlaceholder, placeholderAuth]);

  const tempPacket = Buffer.concat([header, attrBuffer]);
  lengthPlaceholder.writeUInt16BE(tempPacket.length, 0);

  // Build actual packet with request authenticator
  const actualPacket = Buffer.concat([header, attrBuffer]);
  actualPacket.writeUInt16BE(tempPacket.length, 2);
  requestAuth.copy(actualPacket, 4);

  const responseAuth = crypto.createHash('md5')
    .update(Buffer.concat([actualPacket, sharedSecret]))
    .digest();

  const responsePacket = Buffer.concat([
    Buffer.from([code]),
    Buffer.from([id]),
    lengthPlaceholder,
    responseAuth,
    attrBuffer,
  ]);
  lengthPlaceholder.writeUInt16BE(responsePacket.length, 0);

  return responsePacket;
}

function buildAttributes(attributes) {
  const buffers = [];

  for (const [type, values] of Object.entries(attributes)) {
    for (const value of values) {
      const header = Buffer.alloc(2);
      header.writeUInt8(parseInt(type), 0);
      header.writeUInt8(2 + value.length, 1);
      buffers.push(Buffer.concat([header, Buffer.isBuffer(value) ? value : Buffer.from(value)]));
    }
  }

  return Buffer.concat(buffers);
}

async function handleAccessRequest(packet, rinfo) {
  const attrs = packet.attributes;
  const username = attrs[ATTR_USER_NAME]?.[0]?.toString('utf8');
  const nasIp = rinfo.address;

  // Get MAC address from Calling-Station-Id (attribute 31)
  const callingStationId = attrs[31]?.[0]?.toString('utf8');

  console.log(`Access-Request from ${nasIp} - User: ${username || 'N/A'}, MAC: ${callingStationId || 'N/A'}`);

  // Check MAC authorisation first. The portal writes this only after a user
  // pressed "connect now" or completed web-account verification.
  try {
    const { getAuthorizedMac } = require('../routes/api/guest');
    const entry = getAuthorizedMac(callingStationId || username);
    if (entry) {
      const secondsRemaining = Math.max(1, Math.floor((new Date(entry.expires_at).getTime() - Date.now()) / 1000));
      console.log(`Access-Accept for authorised MAC: ${callingStationId || username}`);
      return buildResponse(PACKET_ACCESS_ACCEPT, packet.id, packet.authenticator, {
        [ATTR_SESSION_TIMEOUT]: [uint32(secondsRemaining)],
        [ATTR_REPLY_MESSAGE]: [Buffer.from('MAC authorised by captive portal')],
      }, packet);
    }
  } catch (e) {
    // MAC whitelist module not available, skip
  }

  // If not in whitelist, check regular user credentials
  if (username && attrs[ATTR_USER_PASSWORD]?.[0]) {
    const user = users.getByIdentifier.get(username);
    const password = decodeUserPassword(attrs[ATTR_USER_PASSWORD][0], packet.authenticator);
    if (user && user.is_active && user.password_hash && await require('bcryptjs').compare(password, user.password_hash)) {
      console.log(`Access-Accept for user: ${username}`);
      return buildResponse(PACKET_ACCESS_ACCEPT, packet.id, packet.authenticator, {}, packet);
    }
  }

  // Deny access
  console.log(`Access-Reject for ${username || callingStationId || 'unknown'}`);
  return buildResponse(PACKET_ACCESS_REJECT, packet.id, packet.authenticator, {}, packet);
}

function decodeUserPassword(encrypted, requestAuthenticator) {
  let previous = requestAuthenticator;
  const plainBlocks = [];
  for (let offset = 0; offset < encrypted.length; offset += 16) {
    const block = encrypted.subarray(offset, offset + 16);
    if (block.length !== 16) return '';
    const hash = crypto.createHash('md5').update(Buffer.concat([sharedSecret, previous])).digest();
    const plain = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) plain[i] = block[i] ^ hash[i];
    plainBlocks.push(plain);
    previous = block;
  }
  return Buffer.concat(plainBlocks).toString('utf8').replace(/\0+$/, '');
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

async function handleAccountingRequest(packet, rinfo) {
  const attrs = packet.attributes;
  const sessionId = attrs[ATTR_ACCT_SESSION_ID]?.[0]?.toString('utf8');
  const statusType = attrs[ATTR_ACCT_STATUS_TYPE]?.[0]?.readUInt32BE(0);
  const username = attrs[ATTR_USER_NAME]?.[0]?.toString('utf8');
  const nasIp = attrs[ATTR_NAS_IP]?.[0]?.toString('utf8') || rinfo.address;
  const inputOctets = attrs[ATTR_ACCT_INPUT_OCTETS]?.[0]?.readUInt32BE(0) || 0;
  const outputOctets = attrs[ATTR_ACCT_OUTPUT_OCTETS]?.[0]?.readUInt32BE(0) || 0;

  console.log(`Accounting-Request from ${nasIp}: session=${sessionId}, status=${statusType}`);

  let responseAttrs = {};

  if (statusType === ACCT_STATUS_START) {
    // New session started
    const user = users.getByIdentifier.get(username);
    if (user) {
      const userPackage = packages.getById.get(user.package_id);

      // Create new session
      const newSession = sessions.create.run({
        user_id: user.id,
        package_id: user.package_id,
        mac_address: '00:00:00:00:00:00', // Will be updated by NAS
        ip_address: '0.0.0.0',
        nas_identifier: nasIp,
        username: username,
        session_id: sessionId,
        quota_total_mb: userPackage?.quota_mb || null,
        bandwidth_down_kbps: userPackage?.bandwidth_down_kbps || null,
        bandwidth_up_kbps: userPackage?.bandwidth_up_kbps || null,
      });

      // Update device online status
      const deviceMac = attrs[31]?.[0]?.toString('utf8'); // Calling-Station-Id (31)
      if (deviceMac) {
        await handleNewConnection(user.id, deviceMac, nasIp);

        // Update session with device info
        sessions.update.run({
          ...sessions.getBySessionId.get(sessionId),
          mac_address: deviceMac,
        });
      }

      // Log connection
      logs.create.run({
        user_id: user.id,
        session_id: sessionId,
        mac_address: deviceMac || 'unknown',
        ip_address: nasIp,
        action: 'start',
        nas_identifier: nasIp,
        details: JSON.stringify({ package: userPackage?.name }),
      });
    }
  } else if (statusType === ACCT_STATUS_UPDATE || statusType === ACCT_STATUS_INTERIM) {
    // Interim update - update session activity
    updateSessionActivity(sessionId, inputOctets, outputOctets);

    // Log activity
    const session = sessions.getBySessionId.get(sessionId);
    if (session) {
      logs.create.run({
        user_id: session.user_id,
        session_id: sessionId,
        mac_address: session.mac_address,
        ip_address: nasIp,
        action: 'update',
        nas_identifier: nasIp,
        details: JSON.stringify({ inputOctets, outputOctets }),
      });
    }
  } else if (statusType === ACCT_STATUS_STOP) {
    // Session stopped
    const session = sessions.getBySessionId.get(sessionId);
    if (session) {
      sessions.update.run({
        ...session,
        is_active: 0,
        terminated_by: 'stop_request',
        end_time: new Date().toISOString(),
      });

      devices.setOffline.run(session.mac_address);

      // Log disconnect
      logs.create.run({
        user_id: session.user_id,
        session_id: sessionId,
        mac_address: session.mac_address,
        ip_address: nasIp,
        action: 'stop',
        nas_identifier: nasIp,
        details: JSON.stringify({ inputOctets, outputOctets }),
      });
    }
  }

  // Return Accounting-Response
  return buildResponse(PACKET_ACCOUNTING_RESPONSE, packet.id, packet.authenticator, responseAttrs, packet);
}

function createServer(port) {
  const socket = dgram.createSocket('udp4');

  socket.on('message', async (msg, rinfo) => {
    try {
      const packet = parsePacket(msg);
      if (!packet) return;

      let response;

      switch (packet.code) {
        case PACKET_ACCESS_REQUEST:
          response = await handleAccessRequest(packet, rinfo);
          break;
        case PACKET_ACCOUNTING_REQUEST:
          response = await handleAccountingRequest(packet, rinfo);
          break;
        default:
          console.log(`Unknown RADIUS packet type: ${packet.code}`);
          return;
      }

      if (response) {
        socket.send(response, rinfo.port, rinfo.address);
      }
    } catch (err) {
      console.error('Error handling RADIUS packet:', err);
    }
  });

  socket.on('error', (err) => {
    console.error('RADIUS server error:', err);
  });

  socket.bind(port, () => {
    console.log(`RADIUS server listening on port ${port}`);
  });
  return socket;
}

function start({ authPort = 1812, accountingPort = 1813 } = {}) {
  if (servers.length) return;

  servers = [createServer(authPort)];
  if (accountingPort !== authPort) servers.push(createServer(accountingPort));

  startIdleChecker();
}

function stop() {
  if (servers.length) {
    servers.forEach((socket) => socket.close());
    servers = [];
    stopIdleChecker();
    console.log('RADIUS server stopped');
  }
}

module.exports = {
  start,
  stop,
  parsePacket,
  buildResponse,
};
