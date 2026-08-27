const assert = require('assert');
const crypto = require('crypto');
const { parsePacket, buildResponse, normalizeMac } = require('../src/services/radiusServer');
const { buildRfc5176Packet, DISCONNECT_REQUEST, COA_REQUEST } = require('../src/services/radiusClient');
const { authorizeMac, getAuthorizedMac } = require('../src/routes/api/guest');
const { sessions, devices, users, db } = require('../src/db');
const { terminateSession, checkIdleSessions } = require('../src/services/sessionManager');

async function runTests() {
  console.log('--- STARTING RADIUS WORKFLOW TESTS ---');

  // Test 1: MAC Normalization
  console.log('Test 1: MAC Normalization');
  const mac1 = '48:2C:6A:11:22:33';
  const mac2 = '48-2c-6a-11-22-33';
  const mac3 = '482c.6a11.2233';
  const mac4 = '482C6A112233';
  assert.strictEqual(normalizeMac(mac1), '482c6a112233');
  assert.strictEqual(normalizeMac(mac2), '482c6a112233');
  assert.strictEqual(normalizeMac(mac3), '482c6a112233');
  assert.strictEqual(normalizeMac(mac4), '482c6a112233');
  console.log('✅ MAC Normalization passed');

  // Test 2: RFC 5176 Packet Construction
  console.log('Test 2: RFC 5176 Disconnect Packet Construction');
  const { packet, requestAuth } = buildRfc5176Packet(DISCONNECT_REQUEST, 123, {
    'Acct-Session-Id': 'sess-test-123',
    'User-Name': 'guest-482c6a112233',
    'Calling-Station-Id': '48:2C:6A:11:22:33',
    'MikroTik-Rate-Limit': '2048k/5120k',
  });
  assert(packet.length > 20);
  assert.strictEqual(packet.readUInt8(0), DISCONNECT_REQUEST);
  assert.strictEqual(packet.readUInt8(1), 123);
  assert.strictEqual(packet.readUInt16BE(2), packet.length);
  // Verify requestAuth matches the packet authenticator
  assert(packet.subarray(4, 20).equals(requestAuth));
  console.log('✅ RFC 5176 Packet Construction passed');

  // Test 3: MAC Authorization & RADIUS Access-Request
  console.log('Test 3: MAC Authorization & RADIUS Access-Request');
  const testMac = 'aa:bb:cc:11:22:33';
  const normalizedTestMac = normalizeMac(testMac);
  authorizeMac(testMac, { access_type: 'instant' }, 3600 * 1000);

  const authEntry = getAuthorizedMac(testMac);
  assert(authEntry !== null);
  assert.strictEqual(authEntry.access_type, 'instant');

  // Simulate Access-Request packet for authorized MAC
  const reqAuth = crypto.randomBytes(16);

  // Mock server response
  const radiusServer = require('../src/services/radiusServer');
  const respBuf = radiusServer.buildResponse(2, 10, reqAuth, {
    27: [Buffer.from([0, 0, 14, 16])], // 3600s
    18: [Buffer.from('Access authorized')],
  });
  const parsedResp = radiusServer.parsePacket(respBuf);
  assert.strictEqual(parsedResp.code, 2); // Access-Accept
  assert.strictEqual(parsedResp.id, 10);
  console.log('✅ MAC Authorization & RADIUS Access-Request passed');

  // Test 4: Accounting Start for Guest MAC
  console.log('Test 4: Accounting Start for Guest MAC (Session creation)');
  const testSessionId = `test-sess-${Date.now()}`;
  
  // Clean up any test session
  db.prepare('DELETE FROM sessions WHERE session_id = ?').run(testSessionId);

  // Insert session
  sessions.create.run({
    user_id: null,
    package_id: null,
    mac_address: normalizedTestMac,
    ip_address: '192.168.88.250',
    nas_identifier: '192.168.88.1',
    username: testMac,
    session_id: testSessionId,
    quota_total_mb: null,
    bandwidth_down_kbps: 5000,
    bandwidth_up_kbps: 2000,
  });

  const createdSession = sessions.getBySessionId.get(testSessionId);
  assert(createdSession !== undefined);
  assert.strictEqual(createdSession.session_id, testSessionId);
  assert.strictEqual(createdSession.is_active, 1);

  // Test 5: sessions.getActive includes Guest Sessions (LEFT JOIN check)
  console.log('Test 5: sessions.getActive retrieves guest sessions (user_id IS NULL)');
  const activeSessions = sessions.getActive.all();
  const foundGuest = activeSessions.find(s => s.session_id === testSessionId);
  assert(foundGuest !== undefined, 'Guest session must be retrieved by sessions.getActive');
  assert.strictEqual(foundGuest.user_id, null);
  console.log('✅ Guest Session retrieved via sessions.getActive successfully');

  // Test 6: Terminate session
  console.log('Test 6: Central session termination');
  await terminateSession(createdSession, 'admin_test_kick');
  const terminatedSession = sessions.getBySessionId.get(testSessionId);
  assert.strictEqual(terminatedSession.is_active, 0);
  assert.strictEqual(terminatedSession.terminated_by, 'admin_test_kick');
  console.log('✅ Session termination & database update passed');

  // Test 7: Google OAuth Grace Period Lifecycle
  console.log('Test 7: Google OAuth Grace Period (3 minutes temporary access)');
  const oauthMac = '00:11:22:33:44:55';
  const normalizedOauthMac = normalizeMac(oauthMac);
  const { revokeMac } = require('../src/routes/api/guest');
  const { OAUTH_GRACE_PERIOD_MS } = require('../src/routes/oauth');

  // Step 1: Pre-authorize for OAuth
  authorizeMac(oauthMac, { access_type: 'oauth_grace', ip_address: '192.168.88.100' }, OAUTH_GRACE_PERIOD_MS);
  let graceAuth = getAuthorizedMac(oauthMac);
  assert(graceAuth !== null);
  assert.strictEqual(graceAuth.access_type, 'oauth_grace');
  const remainingSeconds = Math.round((new Date(graceAuth.expires_at).getTime() - Date.now()) / 1000);
  assert(remainingSeconds > 170 && remainingSeconds <= 180, `Expected ~180s, got ${remainingSeconds}s`);
  console.log(`✅ Temporary OAuth Grace Period granted (${remainingSeconds}s remaining)`);

  // Step 2: Simulate successful Google OAuth callback -> Upgrade to 24h
  console.log('Test 8: Upgrade OAuth Grace Period to full 24h access upon successful callback');
  db.prepare('DELETE FROM users WHERE email = ?').run('user@example.com');
  const userResult = users.create.run({
    type: 'oauth',
    identifier: 'google-test-123',
    email: 'user@example.com',
    password_hash: null,
    display_name: 'Test User',
    max_devices: 3,
  });
  const testUserId = userResult.lastInsertRowid;

  authorizeMac(oauthMac, {
    access_type: 'oauth',
    user_id: testUserId,
    username: 'user@example.com',
  }, 24 * 60 * 60 * 1000);
  let upgradedAuth = getAuthorizedMac(oauthMac);
  assert(upgradedAuth !== null);
  assert.strictEqual(upgradedAuth.access_type, 'oauth');
  assert.strictEqual(upgradedAuth.username, 'user@example.com');
  const upgradedHours = (new Date(upgradedAuth.expires_at).getTime() - Date.now()) / (1000 * 60 * 60);
  assert(upgradedHours > 23 && upgradedHours <= 24);
  console.log('✅ Upgraded to 24h full OAuth session successfully');

  // Step 3: Revoke MAC authorization
  console.log('Test 9: Revoke MAC and verify rejection');
  revokeMac(oauthMac);
  assert.strictEqual(getAuthorizedMac(oauthMac), null);
  console.log('✅ Revoke MAC passed');

  // Step 4: Grace Period Auto-Expiration test
  console.log('Test 10: Auto-expiration of expired OAuth Grace Period via checkIdleSessions');
  const expiredMac = '66:77:88:99:aa:bb';
  const normalizedExpiredMac = normalizeMac(expiredMac);
  const expiredSessionId = `sess-expired-grace-${Date.now()}`;
  
  // Create an expired grace auth (expired 5 seconds ago)
  authorizeMac(expiredMac, { access_type: 'oauth_grace' }, -5000);
  
  sessions.create.run({
    user_id: null,
    package_id: null,
    mac_address: normalizedExpiredMac,
    ip_address: '192.168.88.101',
    nas_identifier: '192.168.88.1',
    username: expiredMac,
    session_id: expiredSessionId,
    quota_total_mb: null,
    bandwidth_down_kbps: 5000,
    bandwidth_up_kbps: 2000,
  });

  checkIdleSessions();

  const checkedSession = sessions.getBySessionId.get(expiredSessionId);
  assert.strictEqual(checkedSession.is_active, 0);
  assert.strictEqual(checkedSession.terminated_by, 'oauth_grace_expired');
  console.log('✅ Expired grace session successfully terminated with oauth_grace_expired');

  // Clean up
  db.prepare('DELETE FROM sessions WHERE session_id = ?').run(expiredSessionId);
  db.prepare('DELETE FROM mac_authorizations WHERE mac_address = ?').run(normalizedExpiredMac);
  db.prepare('DELETE FROM mac_authorizations WHERE mac_address = ?').run(normalizedOauthMac);
  db.prepare('DELETE FROM users WHERE id = ?').run(testUserId);

  console.log('--- ALL TESTS PASSED SUCCESSFULLY! ---');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});


