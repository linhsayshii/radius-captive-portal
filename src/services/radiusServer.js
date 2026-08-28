const dgram = require('dgram');
const crypto = require('crypto');
const { loadConfig } = require('../config');
const { sessions, devices, users, logs } = require('../db');
const { startIdleChecker, stopIdleChecker, updateSessionActivity, handleNewConnection } = require('./sessionManager');
const { getAccessPolicy } = require('./accessPolicy');
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
const ATTR_TERMINATION_ACTION = 29;
const ATTR_CALLING_STATION_ID = 31;
const ATTR_ACCT_STATUS_TYPE = 40;
const ATTR_ACCT_INPUT_OCTETS = 42;
const ATTR_ACCT_OUTPUT_OCTETS = 43;
const ATTR_ACCT_SESSION_ID = 44;
const ATTR_ACCT_SESSION_TIME = 46;
const ATTR_ACCT_TERMINATE_CAUSE = 49;
const ATTR_ACCT_INTERIM_INTERVAL = 85;

// Vendor IDs & Attributes
const VENDOR_CISCO = 9;
const CISCO_AVPAIR = 1;

const VENDOR_WISPR = 14122;
const WISPR_BANDWIDTH_MAX_DOWN = 7;
const WISPR_BANDWIDTH_MAX_UP = 8;
const WISPR_QUOTA_LIMIT = 9;

const VENDOR_CHILLISPOT = 14559;
const CHILLISPOT_MAX_TOTAL_OCTETS = 3;
const CHILLISPOT_BANDWIDTH_MAX_UP = 4;
const CHILLISPOT_BANDWIDTH_MAX_DOWN = 5;

const VENDOR_ARUBA = 14823;
const ARUBA_USER_ROLE = 1;
const ARUBA_BANDWIDTH_MAX_UP = 7;
const ARUBA_BANDWIDTH_MAX_DOWN = 8;

const VENDOR_MIKROTIK = 14988;
const MIKROTIK_RATE_LIMIT = 1;
const MIKROTIK_TOTAL_LIMIT = 17;

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
  if (!Buffer.isBuffer(buffer) || buffer.length < 20) return null;

  const code = buffer.readUInt8(0);
  const id = buffer.readUInt8(1);
  const length = buffer.readUInt16BE(2);
  if (length < 20 || length !== buffer.length) return null;

  const authenticator = buffer.subarray(4, 20);
  const attributes = parseAttributes(buffer.subarray(20, length));
  if (!attributes) return null;

  return { code, id, length, authenticator, attributes, raw: buffer };
}

function parseAttributes(buffer) {
  const attrs = {};
  let offset = 0;

  while (offset < buffer.length) {
    if (offset + 2 > buffer.length) return null;
    const type = buffer.readUInt8(offset);
    const len = buffer.readUInt8(offset + 1);

    if (len < 2 || offset + len > buffer.length) return null;

    const value = buffer.subarray(offset + 2, offset + len);

    if (!attrs[type]) attrs[type] = [];
    attrs[type].push(value);

    offset += len;
  }

  return attrs;
}

function readUInt32Attribute(attribute) {
  return attribute && attribute.length === 4 ? attribute.readUInt32BE(0) : null;
}

function isAllowedNas(address) {
  const runtimeConfig = loadConfig();
  const normalizedAddr = (address || '').replace(/^::ffff:/, '');
  if (runtimeConfig.radiusClients.length) {
    if (runtimeConfig.radiusClients.includes('*') || runtimeConfig.radiusClients.includes('0.0.0.0/0')) {
      return true;
    }
    if (runtimeConfig.radiusClients.includes(normalizedAddr)) {
      return true;
    }
    // Always allow localhost in non-production for local testing
    if (runtimeConfig.nodeEnv !== 'production' && (normalizedAddr === '127.0.0.1' || normalizedAddr === '::1' || normalizedAddr === 'localhost')) {
      return true;
    }
    return false;
  }
  // Development remains easy to exercise locally. Production must make the
  // trusted NAS boundary explicit.
  return runtimeConfig.nodeEnv !== 'production';
}

function verifyAccountingRequest(packet) {
  const request = Buffer.from(packet.raw);
  request.fill(0, 4, 20);
  const expected = crypto.createHash('md5')
    .update(Buffer.concat([request, getSharedSecret()]))
    .digest();
  return crypto.timingSafeEqual(expected, packet.authenticator);
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

function buildAccessAccept(packet, user, secondsRemaining, message, authEntry = null) {
  let downKbps = 5000, upKbps = 2000;
  let quotaMb = null;
  let packageName = 'guest';

  if (authEntry?.bandwidth_down_kbps && authEntry?.bandwidth_up_kbps) {
    downKbps = Number(authEntry.bandwidth_down_kbps);
    upKbps = Number(authEntry.bandwidth_up_kbps);
    if (authEntry.quota_mb) {
      quotaMb = Number(authEntry.quota_mb);
    }
    if (authEntry.package_id) {
      const pkg = packages.getById.get(authEntry.package_id);
      if (pkg?.name) packageName = pkg.name;
    }
  } else if (user) {
    const policy = getAccessPolicy(user);
    downKbps = policy.downKbps;
    upKbps = policy.upKbps;
    quotaMb = policy.quotaTotalMb;
    if (policy.package?.name) packageName = policy.package.name;
  }

  const sessionTimeout = Math.max(1, Math.min(secondsRemaining, 0xFFFFFFFF));

  const vsas = [
    // 1. MikroTik Rate Limit: rx/tx (Upload/Download)
    buildVsaBuffer(VENDOR_MIKROTIK, MIKROTIK_RATE_LIMIT, `${upKbps}k/${downKbps}k`),

    // 2. Aruba Instant AP / Virtual Controller (Role-Based and Numeric VSAs)
    buildVsaBuffer(VENDOR_ARUBA, ARUBA_USER_ROLE, packageName),
    buildVsaBuffer(VENDOR_ARUBA, ARUBA_BANDWIDTH_MAX_DOWN, uint32(downKbps)),
    buildVsaBuffer(VENDOR_ARUBA, ARUBA_BANDWIDTH_MAX_UP, uint32(upKbps)),

    // 3. WISPr standard (bits per second)
    buildVsaBuffer(VENDOR_WISPR, WISPR_BANDWIDTH_MAX_DOWN, uint32(downKbps * 1000)),
    buildVsaBuffer(VENDOR_WISPR, WISPR_BANDWIDTH_MAX_UP, uint32(upKbps * 1000)),

    // 4. ChilliSpot / CoovaChilli (bits per second)
    buildVsaBuffer(VENDOR_CHILLISPOT, CHILLISPOT_BANDWIDTH_MAX_DOWN, uint32(downKbps * 1000)),
    buildVsaBuffer(VENDOR_CHILLISPOT, CHILLISPOT_BANDWIDTH_MAX_UP, uint32(upKbps * 1000)),

    // 5. Cisco AVPair (downstream/upstream kbps)
    buildVsaBuffer(VENDOR_CISCO, CISCO_AVPAIR, `subscriber:bandwidth-downstream-kbps=${downKbps}`),
    buildVsaBuffer(VENDOR_CISCO, CISCO_AVPAIR, `subscriber:bandwidth-upstream-kbps=${upKbps}`),
  ];

  // Optional quota limit VSAs if quota_mb is set
  if (quotaMb && quotaMb > 0) {
    const quotaBytes = quotaMb * 1024 * 1024;
    vsas.push(buildVsaBuffer(VENDOR_MIKROTIK, MIKROTIK_TOTAL_LIMIT, uint32(quotaBytes)));
    vsas.push(buildVsaBuffer(VENDOR_CHILLISPOT, CHILLISPOT_MAX_TOTAL_OCTETS, uint32(quotaBytes)));
    vsas.push(buildVsaBuffer(VENDOR_WISPR, WISPR_QUOTA_LIMIT, uint32(quotaMb * 1024))); // in KB
  }

  return buildResponse(PACKET_ACCESS_ACCEPT, packet.id, packet.authenticator, {
    [ATTR_SESSION_TIMEOUT]: [uint32(sessionTimeout)],
    [ATTR_IDLE_TIMEOUT]: [uint32(300)],
    [ATTR_TERMINATION_ACTION]: [uint32(0)], // 0 = default terminate session on timeout
    [ATTR_ACCT_INTERIM_INTERVAL]: [uint32(60)], // Request accounting update every 60 seconds
    [ATTR_REPLY_MESSAGE]: [Buffer.from(message)],
    [ATTR_VENDOR_SPECIFIC]: vsas,
  });
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
        const user = authEntry.user_id ? users.getById.get(authEntry.user_id) : null;
        if (authEntry.user_id && (!user || !user.is_active)) {
          return buildResponse(PACKET_ACCESS_REJECT, packet.id, packet.authenticator, {
            [ATTR_REPLY_MESSAGE]: [Buffer.from('The associated account is inactive')],
          });
        }

        if (user) {
          const policy = getAccessPolicy(user);
          if (!policy.packageValid) {
            return buildResponse(PACKET_ACCESS_REJECT, packet.id, packet.authenticator, {
              [ATTR_REPLY_MESSAGE]: [Buffer.from('The assigned package is inactive')],
            });
          }
        }

        const secondsRemaining = Math.max(
          1,
          Math.floor((new Date(authEntry.expires_at).getTime() - Date.now()) / 1000)
        );
        const downKbps = authEntry.bandwidth_down_kbps
          ? `${authEntry.bandwidth_down_kbps}`
          : (user ? `${getAccessPolicy(user).downKbps}` : '5000');
        const upKbps = authEntry.bandwidth_up_kbps
          ? `${authEntry.bandwidth_up_kbps}`
          : (user ? `${getAccessPolicy(user).upKbps}` : '2000');
        logger.info(`RADIUS Access-Accept for MAC: ${normalizedMac} (${secondsRemaining}s remaining, ${downKbps}/${upKbps} kbps)`);
        return buildAccessAccept(packet, user, secondsRemaining, 'Access authorized by central portal', authEntry);
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
          const policy = getAccessPolicy(user);
          if (!policy.packageValid) {
            return buildResponse(PACKET_ACCESS_REJECT, packet.id, packet.authenticator, {
              [ATTR_REPLY_MESSAGE]: [Buffer.from('The assigned package is inactive')],
            });
          }

          logger.info(`RADIUS Access-Accept for registered user: ${rawUsername}`);
          return buildAccessAccept(packet, user, policy.durationSeconds, 'Welcome ' + (user.display_name || rawUsername));
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
  const statusType = readUInt32Attribute(attrs[ATTR_ACCT_STATUS_TYPE]?.[0]);
  const username = attrs[ATTR_USER_NAME]?.[0]?.toString('utf8') || '';
  const rawCallingStationId = attrs[ATTR_CALLING_STATION_ID]?.[0]?.toString('utf8') || '';
  const nasIp = attrs[ATTR_NAS_IP]?.[0] ? ipBufferToString(attrs[ATTR_NAS_IP][0]) : rinfo.address;
  const framedIp = attrs[ATTR_FRAMED_IP]?.[0] ? ipBufferToString(attrs[ATTR_FRAMED_IP][0]) : null;
  const inputOctets = readUInt32Attribute(attrs[ATTR_ACCT_INPUT_OCTETS]?.[0]) || 0;
  const outputOctets = readUInt32Attribute(attrs[ATTR_ACCT_OUTPUT_OCTETS]?.[0]) || 0;

  const normalizedMac = normalizeMac(rawCallingStationId) || normalizeMac(username) || 'unknown';

  logger.info(`RADIUS Accounting-Request: status=${statusType}, session=${sessionId}, user=${username}, mac=${normalizedMac}`);

  if (statusType === ACCT_STATUS_START) {
    try {
      const usernameUser = users.getByIdentifier.get(username);
      const { getAuthorizedMac } = require('../routes/api/guest');
      const authEntry = getAuthorizedMac(normalizedMac);
      const user = usernameUser || (authEntry?.user_id ? users.getById.get(authEntry.user_id) : null);

      if (authEntry?.user_id && (!user || !user.is_active)) {
        throw new Error('Accounting request belongs to an inactive account');
      }

      if (user) {
        const policy = getAccessPolicy(user);
        if (!policy.packageValid) {
          throw new Error('Accounting request belongs to an inactive package');
        }
      }

      const userId = user?.id || null;
      const packageId = authEntry?.package_id || (user ? getAccessPolicy(user).packageId : null) || null;
      const downKbps = authEntry?.bandwidth_down_kbps
        ? Number(authEntry.bandwidth_down_kbps)
        : (user ? getAccessPolicy(user).downKbps : 5000);
      const upKbps = authEntry?.bandwidth_up_kbps
        ? Number(authEntry.bandwidth_up_kbps)
        : (user ? getAccessPolicy(user).upKbps : 2000);
      const quotaTotalMb = authEntry?.quota_mb
        ? Number(authEntry.quota_mb)
        : (user ? getAccessPolicy(user).quotaTotalMb : null);

      // Deactivate any previous active session for this MAC to prevent duplicate/stale active sessions
      if (normalizedMac && normalizedMac !== 'unknown') {
        const oldActive = sessions.getActiveByMac.get(normalizedMac, normalizedMac);
        if (oldActive && oldActive.session_id !== sessionId) {
          sessions.update.run({
            ...oldActive,
            is_active: 0,
            terminated_by: 'replaced_by_new_session',
            end_time: new Date().toISOString(),
          });
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
          devices.updateConnection.run({
            user_id: userId,
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
          quotaTotalMb,
          packageId,
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
        // Enforce quota limit on interim updates
        if (session.quota_total_mb && session.quota_used_mb >= session.quota_total_mb) {
          logger.info(`Session ${sessionId} exceeded quota (${session.quota_used_mb}MB / ${session.quota_total_mb}MB) during interim update, terminating...`);
          const { terminateSession } = require('./sessionManager');
          void terminateSession(session, 'quota_exceeded', { allowLocalTermination: true });
        }

        logs.create.run({
          user_id: session.user_id,
          session_id: sessionId,
          mac_address: session.mac_address,
          ip_address: framedIp || nasIp,
          action: 'update',
          nas_identifier: nasIp,
          details: JSON.stringify({ inputOctets, outputOctets, quotaUsedMb: session.quota_used_mb }),
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
  let ready;

  socket.on('message', async (msg, rinfo) => {
    try {
      const packet = parsePacket(msg);
      if (!packet) return;
      if (!isAllowedNas(rinfo.address)) {
        logger.warn(`RADIUS packet rejected from untrusted NAS ${rinfo.address}`);
        return;
      }
      if (packet.code === PACKET_ACCOUNTING_REQUEST && !verifyAccountingRequest(packet)) {
        logger.warn(`RADIUS Accounting-Request rejected because its authenticator is invalid (${rinfo.address})`);
        return;
      }

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

  ready = new Promise((resolve, reject) => {
    const onBindError = (err) => {
      socket.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      socket.off('error', onBindError);
      logger.info(`RADIUS ${name} server listening on port ${port}/UDP`);
      resolve();
    };

    socket.once('error', onBindError);
    socket.once('listening', onListening);
    socket.bind(port);
  });

  return { socket, ready };
}

async function start({ authPort = 1812, accountingPort = 1813 } = {}) {
  if (servers.length) return;

  const createdServers = [createServer(authPort, 'Auth')];
  if (accountingPort !== authPort) {
    createdServers.push(createServer(accountingPort, 'Accounting'));
  }

  servers = createdServers.map(({ socket }) => socket);
  try {
    await Promise.all(createdServers.map(({ ready }) => ready));
    startIdleChecker();
  } catch (error) {
    stop();
    throw error;
  }
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
