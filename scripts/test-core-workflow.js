const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDatabasePath = path.join(os.tmpdir(), `wifi-portal-core-${process.pid}.db`);
process.env.DATABASE_PATH = testDatabasePath;
process.env.RADIUS_SHARED_SECRET = 'core-workflow-test-secret';

const Database = require('better-sqlite3');
const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
const setupDatabase = new Database(testDatabasePath);
setupDatabase.exec(schema);
setupDatabase.close();

const { db, macAuthorizations } = require('../src/db');
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

function testDynamicAuthorizationPackets() {
  const disconnect = buildRfc5176Packet(DISCONNECT_REQUEST, 17, {
    'Acct-Session-Id': 'session-test-1',
    'User-Name': 'test-account',
    'Calling-Station-Id': 'aa:bb:cc:dd:ee:ff',
  });
  assert.strictEqual(disconnect.packet.readUInt8(0), DISCONNECT_REQUEST);
  assert.strictEqual(disconnect.packet.readUInt8(1), 17);
  assert.strictEqual(disconnect.packet.readUInt16BE(2), disconnect.packet.length);
  assert(disconnect.packet.subarray(4, 20).equals(disconnect.requestAuth));

  const coa = buildRfc5176Packet(COA_REQUEST, 18, {
    'Acct-Session-Id': 'session-test-1',
    'MikroTik-Rate-Limit': '6000k/12000k',
  });
  const vendorSpecificAttribute = readAttributes(coa.packet).find((attribute) => attribute.type === 26);
  assert(vendorSpecificAttribute, 'CoA must include a Vendor-Specific Attribute for the rate limit');
  assert.strictEqual(vendorSpecificAttribute.value.readUInt32BE(0), 14988);
}

try {
  testMacAuthorization();
  testDynamicAuthorizationPackets();
  console.log('Core portal/RADIUS workflow checks passed.');
} finally {
  db.close();
  fs.rmSync(testDatabasePath, { force: true });
  fs.rmSync(`${testDatabasePath}-wal`, { force: true });
  fs.rmSync(`${testDatabasePath}-shm`, { force: true });
}
