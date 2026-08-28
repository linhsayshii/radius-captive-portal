const dgram = require('dgram');
const crypto = require('crypto');
const { loadConfig } = require('../config');
const logger = require('../utils/logger');

// RADIUS Packet Types (RFC 5176)
const DISCONNECT_REQUEST = 40;
const DISCONNECT_ACK = 41;
const DISCONNECT_NACK = 42;
const COA_REQUEST = 43;
const COA_ACK = 44;
const COA_NACK = 45;

// Standard Attribute Types (RFC 2865, RFC 2866, RFC 5176)
const ATTR_USER_NAME = 1;
const ATTR_NAS_IP = 4;
const ATTR_NAS_PORT = 5;
const ATTR_FRAMED_IP = 8;
const ATTR_REPLY_MESSAGE = 18;
const ATTR_SESSION_TIMEOUT = 27;
const ATTR_IDLE_TIMEOUT = 28;
const ATTR_CALLING_STATION_ID = 31;
const ATTR_ACCT_SESSION_ID = 44;
const ATTR_NAS_PORT_TYPE = 61;
const ATTR_NAS_PORT_ID = 87;
const ATTR_CALLED_STATION_ID = 30;
const ATTR_ERROR_CAUSE = 101;
const ATTR_VENDOR_SPECIFIC = 26;

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
const ARUBA_BANDWIDTH_MAX_UP = 7;
const ARUBA_BANDWIDTH_MAX_DOWN = 8;

const VENDOR_MIKROTIK = 14988;
const MIKROTIK_RATE_LIMIT = 1;
const MIKROTIK_TOTAL_LIMIT = 17;

// Lazy-load config
function getConfig() {
  return loadConfig();
}

function getSharedSecret() {
  return Buffer.from(getConfig().radiusSharedSecret || 'changeme', 'utf8');
}

function ipv4ToBuffer(ipStr) {
  if (!ipStr || typeof ipStr !== 'string') return null;
  const parts = ipStr.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return null;
  return Buffer.from(parts);
}

function nasPortTypeToNumber(value) {
  if (Number.isInteger(Number(value))) return Number(value);
  const normalized = String(value || '').trim().toLowerCase();
  const knownTypes = {
    ethernet: 15,
    cable: 17,
    'wireless-other': 18,
    'wireless-802.11': 19,
    wireless: 19,
  };
  return knownTypes[normalized] ?? null;
}

// The portal stores MAC addresses in canonical separator-free form, while a
// NAS can require the Calling-Station-Id format configured in its Hotspot
// profile. MikroTik in this deployment uses XX:XX:XX:XX:XX:XX for Dynamic
// Authorization matching, so normalize only valid MAC values at the RADIUS
// boundary and leave non-MAC identifiers untouched.
function formatCallingStationId(value) {
  if (typeof value !== 'string') return value;
  const normalized = value.replace(/[^0-9a-f]/gi, '');
  if (!/^[0-9a-f]{12}$/i.test(normalized)) return value;
  return normalized.match(/.{2}/g).join(':').toUpperCase();
}

function parseErrorCause(attributeBuffer) {
  for (let offset = 0; offset + 2 <= attributeBuffer.length;) {
    const type = attributeBuffer.readUInt8(offset);
    const length = attributeBuffer.readUInt8(offset + 1);
    if (length < 2 || offset + length > attributeBuffer.length) break;
    if (type === ATTR_ERROR_CAUSE && length === 6) {
      return attributeBuffer.readUInt32BE(offset + 2);
    }
    offset += length;
  }
  return null;
}

function buildVsa(vendorId, vendorType, valueBuffer) {
  // Vendor-Specific Attribute (Type 26)
  // Format: Type(1) + Length(1) + Vendor-Id(4) + Vendor-Type(1) + Vendor-Length(1) + Value
  const vendorLength = 2 + valueBuffer.length;
  const attrLength = 2 + 4 + vendorLength;

  const buf = Buffer.alloc(attrLength);
  buf.writeUInt8(ATTR_VENDOR_SPECIFIC, 0);
  buf.writeUInt8(attrLength, 1);
  buf.writeUInt32BE(vendorId, 2);
  buf.writeUInt8(vendorType, 6);
  buf.writeUInt8(vendorLength, 7);
  valueBuffer.copy(buf, 8);
  return buf;
}

/**
 * Builds standard attributes and VSAs for RADIUS CoA / Disconnect packets
 */
function buildAttributeBuffers(attrs) {
  const buffers = [];

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === '') continue;

    let type;
    let valBuf;

    switch (key) {
      case 'Acct-Session-Id':
        type = ATTR_ACCT_SESSION_ID;
        valBuf = Buffer.from(String(value), 'utf8');
        break;
      case 'User-Name':
        type = ATTR_USER_NAME;
        valBuf = Buffer.from(String(value), 'utf8');
        break;
      case 'Calling-Station-Id':
        type = ATTR_CALLING_STATION_ID;
        valBuf = Buffer.from(String(formatCallingStationId(value)), 'utf8');
        break;
      case 'NAS-IP-Address':
        type = ATTR_NAS_IP;
        valBuf = ipv4ToBuffer(value);
        if (!valBuf) continue;
        break;
      case 'NAS-Port':
        type = ATTR_NAS_PORT;
        valBuf = Buffer.alloc(4);
        valBuf.writeUInt32BE(Number(value) >>> 0, 0);
        break;
      case 'Framed-IP-Address':
        type = ATTR_FRAMED_IP;
        valBuf = ipv4ToBuffer(value);
        if (!valBuf) continue;
        break;
      case 'NAS-Port-Type': {
        const portType = nasPortTypeToNumber(value);
        if (portType === null) continue;
        type = ATTR_NAS_PORT_TYPE;
        valBuf = Buffer.alloc(4);
        valBuf.writeUInt32BE(portType, 0);
        break;
      }
      case 'NAS-Port-Id':
        type = ATTR_NAS_PORT_ID;
        valBuf = Buffer.from(String(value), 'utf8');
        break;
      case 'Called-Station-Id':
        type = ATTR_CALLED_STATION_ID;
        valBuf = Buffer.from(String(value), 'utf8');
        break;
      case 'Session-Timeout':
        type = ATTR_SESSION_TIMEOUT;
        valBuf = Buffer.alloc(4);
        valBuf.writeUInt32BE(Number(value) >>> 0, 0);
        break;
      case 'Idle-Timeout':
        type = ATTR_IDLE_TIMEOUT;
        valBuf = Buffer.alloc(4);
        valBuf.writeUInt32BE(Number(value) >>> 0, 0);
        break;
      case 'MikroTik-Rate-Limit':
        buffers.push(buildVsa(VENDOR_MIKROTIK, MIKROTIK_RATE_LIMIT, Buffer.from(String(value), 'utf8')));
        continue;
      case 'MikroTik-Total-Limit': {
        const buf = Buffer.alloc(4);
        buf.writeUInt32BE(Number(value) >>> 0, 0);
        buffers.push(buildVsa(VENDOR_MIKROTIK, MIKROTIK_TOTAL_LIMIT, buf));
        continue;
      }
      case 'Aruba-Bandwidth-Max-Down': {
        const buf = Buffer.alloc(4);
        buf.writeUInt32BE(Number(value) >>> 0, 0);
        buffers.push(buildVsa(VENDOR_ARUBA, ARUBA_BANDWIDTH_MAX_DOWN, buf));
        continue;
      }
      case 'Aruba-Bandwidth-Max-Up': {
        const buf = Buffer.alloc(4);
        buf.writeUInt32BE(Number(value) >>> 0, 0);
        buffers.push(buildVsa(VENDOR_ARUBA, ARUBA_BANDWIDTH_MAX_UP, buf));
        continue;
      }
      case 'WISPr-Bandwidth-Max-Down': {
        const buf = Buffer.alloc(4);
        buf.writeUInt32BE(Number(value) >>> 0, 0);
        buffers.push(buildVsa(VENDOR_WISPR, WISPR_BANDWIDTH_MAX_DOWN, buf));
        continue;
      }
      case 'WISPr-Bandwidth-Max-Up': {
        const buf = Buffer.alloc(4);
        buf.writeUInt32BE(Number(value) >>> 0, 0);
        buffers.push(buildVsa(VENDOR_WISPR, WISPR_BANDWIDTH_MAX_UP, buf));
        continue;
      }
      case 'WISPr-Quota-Limit': {
        const buf = Buffer.alloc(4);
        buf.writeUInt32BE(Number(value) >>> 0, 0);
        buffers.push(buildVsa(VENDOR_WISPR, WISPR_QUOTA_LIMIT, buf));
        continue;
      }
      case 'ChilliSpot-Bandwidth-Max-Down': {
        const buf = Buffer.alloc(4);
        buf.writeUInt32BE(Number(value) >>> 0, 0);
        buffers.push(buildVsa(VENDOR_CHILLISPOT, CHILLISPOT_BANDWIDTH_MAX_DOWN, buf));
        continue;
      }
      case 'ChilliSpot-Bandwidth-Max-Up': {
        const buf = Buffer.alloc(4);
        buf.writeUInt32BE(Number(value) >>> 0, 0);
        buffers.push(buildVsa(VENDOR_CHILLISPOT, CHILLISPOT_BANDWIDTH_MAX_UP, buf));
        continue;
      }
      case 'ChilliSpot-Max-Total-Octets': {
        const buf = Buffer.alloc(4);
        buf.writeUInt32BE(Number(value) >>> 0, 0);
        buffers.push(buildVsa(VENDOR_CHILLISPOT, CHILLISPOT_MAX_TOTAL_OCTETS, buf));
        continue;
      }
      case 'Cisco-AVPair':
        buffers.push(buildVsa(VENDOR_CISCO, CISCO_AVPAIR, Buffer.from(String(value), 'utf8')));
        continue;
      default:
        continue;
    }

    const header = Buffer.alloc(2);
    header.writeUInt8(type, 0);
    header.writeUInt8(2 + valBuf.length, 1);
    buffers.push(Buffer.concat([header, valBuf]));
  }

  return Buffer.concat(buffers);
}

/**
 * Builds RFC 5176 compliant Disconnect-Request or CoA-Request packet
 * Request Authenticator = MD5(Code + ID + Length + 16 zero octets + Attributes + SharedSecret)
 */
function buildRfc5176Packet(code, id, attrs) {
  const secret = getSharedSecret();
  const attrBuffer = buildAttributeBuffers(attrs);
  const packetLength = 20 + attrBuffer.length;

  const packet = Buffer.alloc(packetLength);
  packet.writeUInt8(code, 0);
  packet.writeUInt8(id, 1);
  packet.writeUInt16BE(packetLength, 2);
  packet.fill(0, 4, 20); // 16 zero octets for initial authenticator calculation
  attrBuffer.copy(packet, 20);

  // Request Authenticator calculation per RFC 5176 Section 2.3
  const requestAuth = crypto.createHash('md5')
    .update(Buffer.concat([packet, secret]))
    .digest();

  requestAuth.copy(packet, 4);

  return { packet, requestAuth };
}

/**
 * Sends a Dynamic Authorization packet (Disconnect or CoA) to the NAS / Router
 */
async function sendDynAuthPacket(nasIp, code, attributes, timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (!nasIp || nasIp === '0.0.0.0' || nasIp === 'unknown') {
      return resolve({ success: false, error: 'Địa chỉ IP của router (NAS IP) không hợp lệ' });
    }

    const client = dgram.createSocket('udp4');
    const id = Math.floor(Math.random() * 256);
    const { packet, requestAuth } = buildRfc5176Packet(code, id, attributes);
    const coaPort = getConfig().radiusCoaPort || 3799;
    const secret = getSharedSecret();

    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { client.close(); } catch (_) {}
      logger.warn(`RADIUS ${code === DISCONNECT_REQUEST ? 'Disconnect' : 'CoA'} timeout to ${nasIp}:${coaPort}`);
      resolve({ success: false, error: 'Hết thời gian chờ phản hồi từ Router (UDP ' + coaPort + ')' });
    }, timeoutMs);

    client.on('message', (msg, rinfo) => {
      if (finished) return;
      if (msg.length < 20) return;

      if (rinfo.address !== nasIp) {
        logger.warn(`Ignoring RADIUS DynAuth response from unexpected host ${rinfo.address}`);
        return;
      }

      if (msg.readUInt16BE(2) !== msg.length) {
        logger.warn(`RADIUS DynAuth response length mismatch from ${nasIp}`);
        return;
      }

      const respCode = msg.readUInt8(0);
      const respId = msg.readUInt8(1);

      if (respId !== id) return; // Not our packet

      finished = true;
      clearTimeout(timer);
      try { client.close(); } catch (_) {}

      // Verify Response Authenticator (RFC 5176 Section 2.3)
      // MD5(Code + ID + Length + RequestAuth + Attributes + Secret)
      const respHeader = Buffer.concat([
        Buffer.from([msg.readUInt8(0), msg.readUInt8(1)]),
        msg.subarray(2, 4),
        requestAuth,
      ]);
      const respAttrs = msg.subarray(20);
      const expectedAuth = crypto.createHash('md5')
        .update(Buffer.concat([respHeader, respAttrs, secret]))
        .digest();

      const receivedAuth = msg.subarray(4, 20);
      const authValid = crypto.timingSafeEqual(expectedAuth, receivedAuth);

      if (!authValid) {
        logger.warn(`RADIUS DynAuth response authenticator mismatch from ${nasIp}`);
        return resolve({ success: false, error: 'Router trả về RADIUS response authenticator không hợp lệ' });
      }

      if (respCode === DISCONNECT_ACK || respCode === COA_ACK) {
        logger.info(`RADIUS DynAuth SUCCESS from ${nasIp} (Code: ${respCode})`);
        resolve({ success: true, code: respCode });
      } else if (respCode === DISCONNECT_NACK || respCode === COA_NACK) {
        const errorCause = parseErrorCause(respAttrs);
        logger.warn(`RADIUS DynAuth REJECTED by ${nasIp} (Code: ${respCode})`);
        resolve({ success: false, error: 'Router từ chối lệnh ngắt/thay đổi (NACK)', code: respCode, errorCause });
      } else {
        logger.warn(`RADIUS DynAuth unexpected response code: ${respCode} from ${nasIp}`);
        resolve({ success: false, error: `Phản hồi không xác định: ${respCode}`, code: respCode });
      }
    });

    client.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { client.close(); } catch (_) {}
      logger.error('RADIUS DynAuth socket error:', err);
      resolve({ success: false, error: err.message });
    });

    client.send(packet, coaPort, nasIp, (err) => {
      if (err) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try { client.close(); } catch (_) {}
        logger.error('RADIUS DynAuth send error:', err);
        resolve({ success: false, error: err.message });
      }
    });
  });
}

/**
 * Disconnect a session on the router via RADIUS Disconnect-Request (RFC 5176)
 * Supports passing sessionId, macAddress, username, ipAddress for maximum router compatibility
 */
async function disconnectSession(target, legacyNasIp) {
  let nasIp = legacyNasIp;
  let selectors = [];

  if (typeof target === 'object' && target !== null) {
    nasIp = target.nasIp || target.nas_identifier;
    selectors = buildDisconnectSelectors(target);
  } else if (typeof target === 'string') {
    // Legacy invocation: disconnectSession(sessionId, nasIp)
    selectors = [{ label: 'Acct-Session-Id', attributes: { 'Acct-Session-Id': target } }];
  }

  if (!selectors.length) {
    return { success: false, error: 'Thiếu thông tin để nhận diện phiên cần ngắt' };
  }

  let lastResult;
  for (const selector of selectors) {
    logger.info(`Sending RADIUS Disconnect-Request to NAS ${nasIp} using ${selector.label}`, selector.attributes);
    const result = await sendDynAuthPacket(nasIp, DISCONNECT_REQUEST, selector.attributes);
    if (result.success || result.code !== DISCONNECT_NACK || result.errorCause === 405) {
      const { errorCause, ...response } = result;
      return response;
    }
    lastResult = result;
  }
  const { errorCause, ...response } = lastResult;
  return response;
}

/**
 * End a session through the same RouterOS Session-Timeout path used when a
 * customer's time allowance expires. This preserves the NAS's normal captive
 * re-detection behaviour; callers can fall back to Disconnect-Request when a
 * NAS does not accept CoA.
 */
async function expireSession(target, timeoutSeconds = 1) {
  const nasIp = target?.nasIp || target?.nas_identifier;
  const selectors = buildDisconnectSelectors(target || {});
  if (!selectors.length) {
    return { success: false, error: 'Thiếu thông tin để nhận diện phiên cần hết hạn' };
  }

  let lastResult;
  for (const selector of selectors) {
    const attributes = { ...selector.attributes, 'Session-Timeout': Math.max(1, Math.floor(timeoutSeconds)) };
    logger.info(`Sending RADIUS CoA Session-Timeout to NAS ${nasIp} using ${selector.label}`, attributes);
    const result = await sendDynAuthPacket(nasIp, COA_REQUEST, attributes);
    if (result.success) return result;
    lastResult = result;
  }
  return lastResult;
}

// Some NAS implementations require a single selector, and reject a request
// when an otherwise valid session is accompanied by a differently-formatted
// secondary identifier. Try the unique accounting id first, then identity
// selectors sourced from the same accounting record.
function buildDisconnectSelectors(target) {
  const sessionId = target.sessionId || target.session_id;
  const username = target.username;
  const macAddress = formatCallingStationId(target.macAddress || target.mac_address);
  const fullContext = {
    'Acct-Session-Id': sessionId,
    'User-Name': username,
    'NAS-IP-Address': target.nasIp || target.nas_identifier,
    'NAS-Port': target.nasPort || target.nas_port,
    'NAS-Port-Type': target.nasPortType || target.nas_port_type,
    'NAS-Port-Id': target.nasPortId || target.nas_port_id,
    'Framed-IP-Address': target.ipAddress || target.ip_address,
    'Calling-Station-Id': macAddress,
    'Called-Station-Id': target.calledStationId || target.called_station_id,
  };
  const selectors = [];

  if (sessionId && fullContext['NAS-Port'] && fullContext['NAS-Port-Type'] && fullContext['Framed-IP-Address'] && fullContext['Called-Station-Id']) {
    selectors.push({ label: 'MikroTik session context', attributes: fullContext });
  }
  if (sessionId) selectors.push({ label: 'Acct-Session-Id', attributes: { 'Acct-Session-Id': sessionId } });
  if (username && macAddress) selectors.push({
    label: 'User-Name + Calling-Station-Id',
    attributes: { 'User-Name': username, 'Calling-Station-Id': macAddress },
  });
  if (macAddress) selectors.push({ label: 'Calling-Station-Id', attributes: { 'Calling-Station-Id': macAddress } });
  if (username) selectors.push({ label: 'User-Name', attributes: { 'User-Name': username } });
  return selectors;
}

/**
 * Send CoA to modify session bandwidth or attributes on the router
 */
async function sendCoA(nasIp, attributes) {
  logger.info(`Sending RADIUS CoA-Request to NAS ${nasIp}`, attributes);
  return sendDynAuthPacket(nasIp, COA_REQUEST, attributes);
}

/**
 * Change session bandwidth limit on the fly
 */
async function changeBandwidth(sessionId, nasIp, downKbps, upKbps, macAddress) {
  const attrs = {
    'Acct-Session-Id': sessionId,
    'MikroTik-Rate-Limit': `${upKbps}k/${downKbps}k`,
    'Aruba-Bandwidth-Max-Down': downKbps,
    'Aruba-Bandwidth-Max-Up': upKbps,
    'WISPr-Bandwidth-Max-Down': downKbps * 1000,
    'WISPr-Bandwidth-Max-Up': upKbps * 1000,
    'ChilliSpot-Bandwidth-Max-Down': downKbps * 1000,
    'ChilliSpot-Bandwidth-Max-Up': upKbps * 1000,
    'Cisco-AVPair': `subscriber:bandwidth-downstream-kbps=${downKbps}`,
  };
  if (macAddress) attrs['Calling-Station-Id'] = formatCallingStationId(macAddress);
  return sendCoA(nasIp, attrs);
}

/**
 * Apply session quota limit
 */
async function applyQuota(sessionId, nasIp, quotaMb, macAddress) {
  const quotaBytes = quotaMb * 1024 * 1024;
  const attrs = {
    'Acct-Session-Id': sessionId,
    'MikroTik-Total-Limit': quotaBytes,
    'WISPr-Quota-Limit': quotaMb * 1024,
    'ChilliSpot-Max-Total-Octets': quotaBytes,
  };
  if (macAddress) attrs['Calling-Station-Id'] = formatCallingStationId(macAddress);
  return sendCoA(nasIp, attrs);
}

module.exports = {
  sendCoA,
  disconnectSession,
  expireSession,
  changeBandwidth,
  applyQuota,
  buildRfc5176Packet,
  formatCallingStationId,
  buildDisconnectSelectors,
  DISCONNECT_REQUEST,
  DISCONNECT_ACK,
  DISCONNECT_NACK,
  COA_REQUEST,
  COA_ACK,
  COA_NACK,
};
