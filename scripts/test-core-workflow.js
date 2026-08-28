const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDatabasePath = path.join(os.tmpdir(), `wifi-portal-core-${process.pid}.db`);
process.env.DATABASE_PATH = testDatabasePath;
process.env.RADIUS_SHARED_SECRET = 'core-workflow-test-secret';

const { db, macAuthorizations } = require('../src/db');
const { getDevicesWithLiveStatus } = require('../src/services/deviceStatus');
const { calculateAccountingRates } = require('../src/services/sessionManager');
const { getAccessPolicy, getAuthorizationDurationMs } = require('../src/services/accessPolicy');
const {
  normalizeMac,
  authorizeMac,
  getAuthorizedMac,
  revokeMac,
} = require('../src/routes/api/guest');
const { normalizeMac: normalizeAccountingMac } = require('../src/services/radiusAccountingSync');
const {
  buildRfc5176Packet,
  DISCONNECT_REQUEST,
  COA_REQUEST,
  formatCallingStationId,
  buildDisconnectSelectors,
} = require('../src/services/radiusClient');

function readAttributes(packet) {
  const attributes = [];
  for (let offset = 20; offset < packet.length;) {
    const type = packet.readUInt8(offset);
    const length = packet.readUInt8(offset + 1);
    attributes.push({ type, value: packet.subarray(offset + 2, offset + length) });
    offset += length;
  }
  return attributes;
}

function testMacAuthorization() {
  const rawMac = 'AA:BB-CC.DD EE:FF';
  const canonicalMac = 'aabbccddeeff';
  assert.strictEqual(normalizeMac(rawMac), canonicalMac);
  assert.strictEqual(normalizeAccountingMac(rawMac), canonicalMac);

  const authorization = authorizeMac(rawMac, {
    access_type: 'account',
    username: 'test-account',
    bandwidth_down_kbps: 12000,
    bandwidth_up_kbps: 6000,
  }, 60 * 60 * 1000);

  assert.strictEqual(authorization.mac_address, canonicalMac);
  assert.strictEqual(getAuthorizedMac(canonicalMac).username, 'test-account');
  assert.strictEqual(macAuthorizations.get.get(canonicalMac).bandwidth_down_kbps, 12000);
  assert.strictEqual(revokeMac(canonicalMac), true);
  assert.strictEqual(getAuthorizedMac(canonicalMac), null);
}

function testFreshDatabaseStartup() {
  const usersTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  const sessionsTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get();
  assert(usersTable, 'Fresh portal database must initialize the users table before queries are prepared');
  assert(sessionsTable, 'Fresh portal database must initialize the sessions table before queries are prepared');
  const userColumns = db.prepare("PRAGMA table_info(users)").all().map((column) => column.name);
  assert(userColumns.includes('bandwidth_down_kbps'), 'Users must support a custom download rate');
  assert(userColumns.includes('bandwidth_up_kbps'), 'Users must support a custom upload rate');
}

function testAccountAccessPolicies() {
  const unlimited = getAccessPolicy({ id: 1, max_devices: 2, package_id: null });
  assert.strictEqual(unlimited.packageId, null);
  assert.strictEqual(unlimited.durationSeconds, null, 'An account without a package must not inherit a session duration');
  assert.strictEqual(unlimited.downKbps, null, 'An account without a package must not inherit a download limit');
  assert.strictEqual(unlimited.upKbps, null, 'An account without a package must not inherit an upload limit');
  assert.strictEqual(getAuthorizationDurationMs({ id: 1, max_devices: 2, package_id: null }), 365 * 24 * 60 * 60 * 1000);

  const customRate = getAccessPolicy({
    id: 2,
    max_devices: 1,
    package_id: null,
    bandwidth_down_kbps: 25000,
    bandwidth_up_kbps: 10000,
  });
  assert.strictEqual(customRate.downKbps, 25000);
  assert.strictEqual(customRate.upKbps, 10000);

  const customDuration = getAccessPolicy({ id: 3, max_devices: 1, package_id: null, duration_minutes: 90 });
  assert.strictEqual(customDuration.durationSeconds, 90 * 60);
  assert.strictEqual(customDuration.authorizationDurationSeconds, 90 * 60);
}

function testDynamicAuthorizationPackets() {
  assert.strictEqual(formatCallingStationId('aabbccddeeff'), 'AA:BB:CC:DD:EE:FF');
  assert.strictEqual(formatCallingStationId('aa-bb-cc-dd-ee-ff'), 'AA:BB:CC:DD:EE:FF');

  const disconnect = buildRfc5176Packet(DISCONNECT_REQUEST, 17, {
    'Acct-Session-Id': 'session-test-1',
    'User-Name': 'test-account',
    'Calling-Station-Id': 'aa:bb:cc:dd:ee:ff',
  });
  assert.strictEqual(disconnect.packet.readUInt8(0), DISCONNECT_REQUEST);
  assert.strictEqual(disconnect.packet.readUInt8(1), 17);
  assert.strictEqual(disconnect.packet.readUInt16BE(2), disconnect.packet.length);
  assert(disconnect.packet.subarray(4, 20).equals(disconnect.requestAuth));
  const callingStationId = readAttributes(disconnect.packet).find((attribute) => attribute.type === 31);
  assert.strictEqual(callingStationId.value.toString('utf8'), 'AA:BB:CC:DD:EE:FF');

  const selectors = buildDisconnectSelectors({
    sessionId: 'session-test-1',
    username: 'test-account',
    macAddress: 'aa-bb-cc-dd-ee-ff',
    nasIp: '192.168.88.1',
    nasPort: '12',
    nasPortType: 'Wireless-802.11',
    nasPortId: 'wlan1',
    ipAddress: '192.168.88.20',
    calledStationId: 'hotspot1',
  });
  assert.deepStrictEqual(selectors.map((selector) => selector.label), [
    'MikroTik session context',
    'Acct-Session-Id',
    'User-Name + Calling-Station-Id',
    'Calling-Station-Id',
    'User-Name',
  ]);
  assert.strictEqual(selectors[0].attributes['Calling-Station-Id'], 'AA:BB:CC:DD:EE:FF');
  assert.strictEqual(selectors[0].attributes['NAS-Port-Type'], 'Wireless-802.11');

  const coa = buildRfc5176Packet(COA_REQUEST, 18, {
    'Acct-Session-Id': 'session-test-1',
    'MikroTik-Rate-Limit': '6000k/12000k',
  });
  const vendorSpecificAttribute = readAttributes(coa.packet).find((attribute) => attribute.type === 26);
  assert(vendorSpecificAttribute, 'CoA must include a Vendor-Specific Attribute for the rate limit');
  assert.strictEqual(vendorSpecificAttribute.value.readUInt32BE(0), 14988);
}

function testDeviceStatusUsesActiveSession() {
  const macAddress = '112233445566';
  const staleSessionId = 'stale-device-session';
  const activeSessionId = 'active-device-session';

  const insertSession = db.prepare(`
    INSERT INTO sessions (mac_address, username, session_id, is_active, start_time, last_activity)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertSession.run(macAddress, 'old-user', staleSessionId, 0, '2026-08-28T15:00:00.000Z', '2026-08-28T15:00:10.000Z');
  const staleSession = db.prepare('SELECT id FROM sessions WHERE session_id = ?').get(staleSessionId);
  insertSession.run(macAddress, 'current-user', activeSessionId, 1, '2026-08-28T16:00:00.000Z', '2026-08-28T16:00:20.000Z');

  db.prepare(`
    INSERT INTO devices (mac_address, session_id, is_online, last_seen)
    VALUES (?, ?, 0, '2026-08-28 15:00:10')
  `).run(macAddress, staleSession.id);

  const device = getDevicesWithLiveStatus().find((item) => item.mac_address === macAddress);
  assert(device, 'Device must be listed');
  assert.strictEqual(device.is_online, 1, 'An active RADIUS session must override a stale offline device flag');
  assert.strictEqual(device.username, 'current-user');
  assert.strictEqual(device.last_seen, '2026-08-28T16:00:20.000Z');
}

function testAccountingDirection() {
  const rates = calculateAccountingRates(1024, 4096, 1);
  assert.strictEqual(rates.rateUpKbps, 8, 'Acct-Input-Octets must be displayed as upload');
  assert.strictEqual(rates.rateDownKbps, 32, 'Acct-Output-Octets must be displayed as download');
}

try {
  testFreshDatabaseStartup();
  testAccountAccessPolicies();
  testMacAuthorization();
  testDynamicAuthorizationPackets();
  testDeviceStatusUsesActiveSession();
  testAccountingDirection();
  console.log('Core portal/RADIUS workflow checks passed.');
} finally {
  db.close();
  fs.rmSync(testDatabasePath, { force: true });
  fs.rmSync(`${testDatabasePath}-wal`, { force: true });
  fs.rmSync(`${testDatabasePath}-shm`, { force: true });
}
