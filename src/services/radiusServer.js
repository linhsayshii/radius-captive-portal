const dgram = require('dgram');
const crypto = require('crypto');
const { loadConfig } = require('../config');
const { sessions, devices, users, packages, logs, settings, macAuthorizations } = require('../db');
const { startIdleChecker, stopIdleChecker, updateSessionActivity, handleNewConnection } = require('./sessionManager');
const logger = require('../utils/logger');

const config = loadConfig();

// RADIUS packet types (RFC 2865, RFC 2866)
const PACKET_ACCESS_REQUEST = 1;
const PACKET_ACCESS_ACCEPT = 2;
const PACKET_ACCESS_REJECT = 3;
const PACKET_ACCOUNTING_REQUEST = 4;
const PACKET_ACCOUNTING_RESPONSE = 5;
const PACKET_ACCESS_CHALLENGE = 11;

// RADIUS attribute types
const ATTR_USER_NAME = 1;
const ATTR_USER_PASSWORD = 2;
const ATTR_NAS_IP = 4;
const ATTR_NAS_PORT = 5;
const ATTR_SERVICE_TYPE = 6;
const ATTR_FRAMED_IP = 8;
const ATTR_REPLY_MESSAGE = 18;
const ATTR_VENDOR_SPECIFIC = 26;
const ATTR_SESSION_TIMEOUT = 27;
const ATTR_IDLE_TIMEOUT = 28;
const ATTR_CALLING_STATION_ID = 31;
const ATTR_ACCT_STATUS_TYPE = 40;
const ATTR_ACCT_INPUT_OCTETS = 42;
const ATTR_ACCT_OUTPUT_OCTETS = 43;
const ATTR_ACCT_SESSION_ID = 44;
const ATTR_ACCT_SESSION_TIME = 46;
const ATTR_ACCT_TERMINATE_CAUSE = 49;

// Vendor IDs
const VENDOR_MIKROTIK = 14988;
const MIKROTIK_RATE_LIMIT = 1;

const VENDOR_WISPR = 14122;
const WISPR_BANDWIDTH_MAX_DOWN = 7;
const WISPR_BANDWIDTH_MAX_UP = 8;

// Accounting status types
const ACCT_STATUS_START = 1;
const ACCT_STATUS_STOP = 2;
const ACCT_STATUS_UPDATE = 3;
const ACCT_STATUS_INTERIM = 3;

// NAS shared secret
function getSharedSecret() {
  return Buffer.from(loadConfig().radiusSharedSecret || 'changeme', 'utf8');
}

// Server instances
let servers = [];

function normalizeMac(mac) {
  if (typeof mac !== 'string') return null;
  const normalized = mac.replace(/[:\-\.\s]/g, '').toLowerCase();
  return /^[0-9a-f]{12}$/.test(normalized) ? normalized : null;
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(Number(value) >>> 0, 0);
  return buffer;
}

function ipBufferToString(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length !== 4) return null;
  return `${buf[0]}.${buf[1]}.${buf[2]}.${buf[3]}`;
}

function buildVsaBuffer(vendorId, vendorType, value) {
  const valueBuf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const vendorLength = 2 + valueBuf.length;
  const totalLength = 4 + vendorLength;

  const buf = Buffer.alloc(totalLength);
  buf.writeUInt32BE(vendorId, 0);
  buf.writeUInt8(vendorType, 4);
  buf.writeUInt8(vendorLength, 5);
  valueBuf.copy(buf, 6);
  return buf;
}

function parsePacket(buffer) {
  if (buffer.length < 20) return null;

  const code = buffer.readUInt8(0);
  const id = buffer.readUInt8(1);
  const length = buffer.readUInt16BE(2);
  const authenticator = buffer.subarray(4, 20);
  const attributes = parseAttributes(buffer.subarray(20, length));

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

function buildResponse(requestCode, requestId, requestAuth, attributes) {
  const code = requestCode;
  const id = requestId;
  const attrBuffer = buildAttributes(attributes);
  const secret = getSharedSecret();

  // Response packet: Code(1) + ID(1) + Length(2) + ResponseAuth(16) + Attributes
  const packetLength = 20 + attrBuffer.length;
  const packet = Buffer.alloc(packetLength);

  packet.writeUInt8(code, 0);
  packet.writeUInt8(id, 1);
  packet.writeUInt16BE(packetLength, 2);
  requestAuth.copy(packet, 4); // Put request authenticator for hashing
  attrBuffer.copy(packet, 20);

  // Response Authenticator = MD5(Code + ID + Length + RequestAuth + Attributes + Secret)
  const responseAuth = crypto.createHash('md5')
    .update(Buffer.concat([packet, secret]))
    .digest();

  responseAuth.copy(packet, 4);

  return packet;
}

function buildAttributes(attributes) {
  const buffers = [];

  for (const [type, values] of Object.entries(attributes)) {
    if (!values) continue;
    const valArray = Array.isArray(values) ? values : [values];

    for (const value of valArray) {
      if (value === undefined || value === null) continue;
      const valBuf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
      const header = Buffer.alloc(2);
      header.writeUInt8(parseInt(type, 10), 0);
      header.writeUInt8(2 + valBuf.length, 1);
      buffers.push(Buffer.concat([header, valBuf]));
    }
  }

  return Buffer.concat(buffers);
}

function decodeUserPassword(encrypted, requestAuthenticator) {
  const secret = getSharedSecret();
  let previous = requestAuthenticator;
  const plainBlocks = [];

  for (let offset = 0; offset < encrypted.length; offset += 16) {
    const block = encrypted.subarray(offset, offset + 16);
    if (block.length !== 16) return '';
    const hash = crypto.createHash('md5').update(Buffer.concat([secret, previous])).digest();
    const plain = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) plain[i] = block[i] ^ hash[i];
    plainBlocks.push(plain);
    previous = block;
  }

  return Buffer.concat(plainBlocks).toString('utf8').replace(/\0+$/, '');
}

/**
 * Handle RADIUS Access-Request from Router (NAS)
 */
async function handleAccessRequest(packet, rinfo) {
  const attrs = packet.attributes;
  const rawUsername = attrs[ATTR_USER_NAME]?.[0]?.toString('utf8') || '';
  const rawCallingStationId = attrs[ATTR_CALLING_STATION_ID]?.[0]?.toString('utf8') || '';
  const nasIp = rinfo.address;

  const normalizedMac = normalizeMac(rawCallingStationId) || normalizeMac(rawUsername);

  logger.info(`RADIUS Access-Request from ${nasIp} - User: ${rawUsername || 'N/A'}, MAC: ${rawCallingStationId || 'N/A'}`);

  // 1. Check MAC authorization (Instant Guest, Google OAuth, or Web Local login)
  if (normalizedMac) {
    try {
      const { getAuthorizedMac } = require('../routes/api/guest');
      const authEntry = getAuthorizedMac(normalizedMac);

      if (authEntry) {
        const secondsRemaining = Math.max(
          1,
          Math.floor((new Date(authEntry.expires_at).getTime() - Date.now()) / 1000)
        );

        let downKbps = 5000;
        let upKbps = 2000;

        if (authEntry.user_id) {
          const user = users.getById.get(authEntry.user_id);
          if (user?.package_id) {
            const userPkg = packages.getById.get(user.package_id);
            if (userPkg) {
              downKbps = userPkg.bandwidth_down_kbps || downKbps;
              upKbps = userPkg.bandwidth_up_kbps || upKbps;
            }
          }
        }

        logger.info(`RADIUS Access-Accept for MAC: ${normalizedMac} (${secondsRemaining}s remaining, ${downKbps}/${upKbps} kbps)`);

        const responseAttrs = {
          [ATTR_SESSION_TIMEOUT]: [uint32(secondsRemaining)],
          [ATTR_IDLE_TIMEOUT]: [uint32(300)],
          [ATTR_REPLY_MESSAGE]: [Buffer.from('Access authorized by central portal')],
          [ATTR_VENDOR_SPECIFIC]: [
            // MikroTik VSA rate limit: upload/download
            buildVsaBuffer(VENDOR_MIKROTIK, MIKROTIK_RATE_LIMIT, `${upKbps}k/${downKbps}k`),
            // WISPr rate limit in bps
            buildVsaBuffer(VENDOR_WISPR, WISPR_BANDWIDTH_MAX_DOWN, uint32(downKbps * 1000)),
            buildVsaBuffer(VENDOR_WISPR, WISPR_BANDWIDTH_MAX_UP, uint32(upKbps * 1000)),
          ],
        };

        return buildResponse(PACKET_ACCESS_ACCEPT, packet.id, packet.authenticator, responseAttrs);
      }
    } catch (err) {
      logger.error('Error verifying MAC authorization:', err);
    }
  }

  // 2. Direct PAP credentials check (if router uses PAP with registered user)
  if (rawUsername && attrs[ATTR_USER_PASSWORD]?.[0]) {
    try {
      const user = users.getByIdentifier.get(rawUsername);
      if (user && user.is_active && user.password_hash) {
        const password = decodeUserPassword(attrs[ATTR_USER_PASSWORD][0], packet.authenticator);
        const valid = await require('bcryptjs').compare(password, user.password_hash);

        if (valid) {
          let downKbps = 5000;
          let upKbps = 2000;
          let durationSeconds = 86400;

          if (user.package_id) {
            const userPkg = packages.getById.get(user.package_id);
            if (userPkg) {
              downKbps = userPkg.bandwidth_down_kbps || downKbps;
              upKbps = userPkg.bandwidth_up_kbps || upKbps;
              durationSeconds = (userPkg.duration_minutes || 1440) * 60;
            }
          }

          logger.info(`RADIUS Access-Accept for registered user: ${rawUsername}`);

          const responseAttrs = {
            [ATTR_SESSION_TIMEOUT]: [uint32(durationSeconds)],
            [ATTR_IDLE_TIMEOUT]: [uint32(300)],
            [ATTR_REPLY_MESSAGE]: [Buffer.from('Welcome ' + (user.display_name || rawUsername))],
            [ATTR_VENDOR_SPECIFIC]: [
              buildVsaBuffer(VENDOR_MIKROTIK, MIKROTIK_RATE_LIMIT, `${upKbps}k/${downKbps}k`),
              buildVsaBuffer(VENDOR_WISPR, WISPR_BANDWIDTH_MAX_DOWN, uint32(downKbps * 1000)),
              buildVsaBuffer(VENDOR_WISPR, WISPR_BANDWIDTH_MAX_UP, uint32(upKbps * 1000)),
            ],
          };

          return buildResponse(PACKET_ACCESS_ACCEPT, packet.id, packet.authenticator, responseAttrs);
        }
      }
    } catch (err) {
      logger.error('Error verifying PAP user:', err);
    }
  }

  // 3. Deny access
  logger.warn(`RADIUS Access-Reject for ${rawUsername || rawCallingStationId || 'unknown device'}`);
  return buildResponse(PACKET_ACCESS_REJECT, packet.id, packet.authenticator, {
    [ATTR_REPLY_MESSAGE]: [Buffer.from('Access denied. Please authenticate via portal.')],
  });
}

/**
 * Handle RADIUS Accounting-Request (Start, Interim-Update, Stop)
 */
async function handleAccountingRequest(packet, rinfo) {
  const attrs = packet.attributes;
  const sessionId = attrs[ATTR_ACCT_SESSION_ID]?.[0]?.toString('utf8') || `sess-${Date.now()}`;
  const statusType = attrs[ATTR_ACCT_STATUS_TYPE]?.[0]?.readUInt32BE(0);
  const username = attrs[ATTR_USER_NAME]?.[0]?.toString('utf8') || '';
  const rawCallingStationId = attrs[ATTR_CALLING_STATION_ID]?.[0]?.toString('utf8') || '';
  const nasIp = attrs[ATTR_NAS_IP]?.[0] ? ipBufferToString(attrs[ATTR_NAS_IP][0]) : rinfo.address;
  const framedIp = attrs[ATTR_FRAMED_IP]?.[0] ? ipBufferToString(attrs[ATTR_FRAMED_IP][0]) : null;
  const inputOctets = attrs[ATTR_ACCT_INPUT_OCTETS]?.[0]?.readUInt32BE(0) || 0;
  const outputOctets = attrs[ATTR_ACCT_OUTPUT_OCTETS]?.[0]?.readUInt32BE(0) || 0;

  const normalizedMac = normalizeMac(rawCallingStationId) || normalizeMac(username) || 'unknown';

  logger.info(`RADIUS Accounting-Request: status=${statusType}, session=${sessionId}, user=${username}, mac=${normalizedMac}`);

  if (statusType === ACCT_STATUS_START) {
    try {
      const user = users.getByIdentifier.get(username);
      const { getAuthorizedMac } = require('../routes/api/guest');
      const authEntry = getAuthorizedMac(normalizedMac);

      let userId = user?.id || authEntry?.user_id || null;
      let packageId = user?.package_id || null;
      let downKbps = 5000;
      let upKbps = 2000;
      let quotaTotalMb = null;

      if (packageId) {
        const userPkg = packages.getById.get(packageId);
        if (userPkg) {
          downKbps = userPkg.bandwidth_down_kbps || downKbps;
          upKbps = userPkg.bandwidth_up_kbps || upKbps;
          quotaTotalMb = userPkg.quota_mb || null;
        }
      }

      // Check if session already exists
      const existingSession = sessions.getBySessionId.get(sessionId);
      if (!existingSession) {
        sessions.create.run({
          user_id: userId,
          package_id: packageId,
          mac_address: normalizedMac,
          ip_address: framedIp || nasIp,
          nas_identifier: nasIp,
          username: username || normalizedMac,
          session_id: sessionId,
          quota_total_mb: quotaTotalMb,
          bandwidth_down_kbps: downKbps,
          bandwidth_up_kbps: upKbps,
        });
      }

      const activeSession = sessions.getBySessionId.get(sessionId);

      // Track device
      if (normalizedMac && normalizedMac !== 'unknown') {
        const existingDevice = devices.getByMac.get(normalizedMac);
        if (existingDevice) {
          devices.updateOnline.run({
            is_online: 1,
            session_id: activeSession?.id || null,
            mac_address: normalizedMac,
          });
        } else {
          devices.create.run({
            user_id: userId,
            mac_address: normalizedMac,
            device_name: username ? `Device (${username})` : `Guest (${normalizedMac})`,
            session_id: activeSession?.id || null,
          });
          devices.updateOnline.run({
            is_online: 1,
            session_id: activeSession?.id || null,
            mac_address: normalizedMac,
          });
        }

        if (userId) {
          await handleNewConnection(userId, normalizedMac, nasIp);
        }
      }

      // Log connection
      logs.create.run({
        user_id: userId,
        session_id: sessionId,
        mac_address: normalizedMac,
        ip_address: framedIp || nasIp,
        action: 'start',
        nas_identifier: nasIp,
        details: JSON.stringify({
          username: username || normalizedMac,
          framedIp,
          downKbps,
          upKbps,
        }),
      });
    } catch (err) {
      logger.error('Error handling Accounting Start:', err);
    }
  } else if (statusType === ACCT_STATUS_UPDATE || statusType === ACCT_STATUS_INTERIM) {
    try {
      updateSessionActivity(sessionId, inputOctets, outputOctets);

      const session = sessions.getBySessionId.get(sessionId);
      if (session) {
        logs.create.run({
          user_id: session.user_id,
          session_id: sessionId,
          mac_address: session.mac_address,
          ip_address: framedIp || nasIp,
          action: 'update',
          nas_identifier: nasIp,
          details: JSON.stringify({ inputOctets, outputOctets }),
        });
      }
    } catch (err) {
      logger.error('Error handling Accounting Update:', err);
    }
  } else if (statusType === ACCT_STATUS_STOP) {
    try {
      const session = sessions.getBySessionId.get(sessionId) || sessions.getActiveByMac.get(normalizedMac, normalizedMac);
      if (session) {
        sessions.update.run({
          ...session,
          is_active: 0,
          terminated_by: 'nas_stop',
          end_time: new Date().toISOString(),
        });

        if (session.mac_address) {
          devices.setOffline.run(session.mac_address);
        }

        logs.create.run({
          user_id: session.user_id,
          session_id: sessionId,
          mac_address: session.mac_address,
          ip_address: framedIp || nasIp,
          action: 'stop',
          nas_identifier: nasIp,
          details: JSON.stringify({ inputOctets, outputOctets }),
        });
      }
    } catch (err) {
      logger.error('Error handling Accounting Stop:', err);
    }
  }

  // Always reply with Accounting-Response
  return buildResponse(PACKET_ACCOUNTING_RESPONSE, packet.id, packet.authenticator, {});
}

function createServer(port, name) {
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
          logger.warn(`Unknown RADIUS packet type: ${packet.code}`);
          return;
      }

      if (response) {
        socket.send(response, rinfo.port, rinfo.address);
      }
    } catch (err) {
      logger.error('Error handling RADIUS packet:', err);
    }
  });

  socket.on('error', (err) => {
    logger.error(`RADIUS server error on port ${port}:`, err);
  });

  socket.bind(port, () => {
    logger.info(`RADIUS ${name} server listening on port ${port}/UDP`);
  });

  return socket;
}

function start({ authPort = 1812, accountingPort = 1813 } = {}) {
  if (servers.length) return;

  servers = [createServer(authPort, 'Auth')];
  if (accountingPort !== authPort) {
    servers.push(createServer(accountingPort, 'Accounting'));
  }

  startIdleChecker();
}

function stop() {
  if (servers.length) {
    servers.forEach((socket) => {
      try { socket.close(); } catch (_) {}
    });
    servers = [];
    stopIdleChecker();
    logger.info('RADIUS server stopped');
  }
}

module.exports = {
  start,
  stop,
  parsePacket,
  buildResponse,
  normalizeMac,
  buildVsaBuffer,
};

