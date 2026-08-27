# WiFi Portal Phase 2: RADIUS + Session Management

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build RADIUS server, Google OAuth, and session management with activity tracking

**Architecture:** RADIUS server handles MikroTik authentication. Session manager tracks user activity. OAuth flow integrated with whitelist.

**Tech Stack:** Node.js, better-sqlite3, passport.js, custom RADIUS server

**Spec:** `../SPEC.md`

---

## Global Constraints

- Node.js 18+
- bcrypt cost factor: 12
- Session secret min 32 chars
- All DB queries: parameterized (no SQL injection)
- RADIUS CoA Port: 3799
- Activity threshold: 1024 bytes

---

## Task 1: Google OAuth Setup

**Files:**
- Create: `src/routes/oauth.js`
- Modify: `src/config/index.js`
- Modify: `src/app.js`

**Interfaces:**
- Produces: Google OAuth flow with whitelist check

- [ ] **Step 1: Update config with OAuth settings**

Add to `src/config/index.js`:
```javascript
// Already have these from Phase 1:
// googleClientId, googleClientSecret, googleCallbackUrl
```

- [ ] **Step 2: Create src/routes/oauth.js**

```javascript
const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { users, oauth } = require('../db');
const config = require('../config');

const router = express.Router();

// Configure Passport
passport.use(new GoogleStrategy({
  clientID: config.googleClientId,
  clientSecret: config.googleClientSecret,
  callbackURL: config.googleCallbackUrl,
}, async (accessToken, refreshToken, profile, done) => {
  const email = profile.emails[0].value;
  
  // Check whitelist
  const whitelistEntry = oauth.getByEmail.get(email);
  if (!whitelistEntry) {
    return done(null, false, { message: 'Email not whitelisted' });
  }
  
  // Find or create user
  let user = users.getByEmail.get(email);
  if (!user) {
    const result = users.create.run({
      type: 'oauth',
      identifier: profile.id,
      email: email,
      password_hash: null,
      display_name: profile.displayName,
      max_devices: 3,
    });
    user = { id: result.lastInsertRowid };
  }
  
  done(null, { id: user.id, email, type: 'oauth' });
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// OAuth routes
router.get('/google', passport.authenticate('google', {
  scope: ['profile', 'email'],
  prompt: 'select_account',
}));

router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: '/error.html?error=unauthorized' }),
  (req, res) => {
    // Store in session and redirect to success
    req.session.userId = req.user.id;
    req.session.userType = 'oauth';
    res.redirect('/success.html');
  }
);

module.exports = { router, passport };
```

- [ ] **Step 3: Update src/app.js to mount OAuth**

```javascript
// Add after other requires
const { passport } = require('./routes/oauth');

// Add after session config
app.use(passport.initialize());
app.use(passport.session());

// Add OAuth route
app.use('/auth', require('./routes/oauth').router);
```

- [ ] **Step 4: Commit**

```bash
git add src/routes/oauth.js src/config/index.js src/app.js
git commit -m "feat(oauth): add Google OAuth with passport"
```

---

## Task 2: RADIUS Server

**Files:**
- Create: `src/services/radiusServer.js`
- Create: `src/services/radiusClient.js`
- Modify: `src/index.js`

**Interfaces:**
- Produces: RADIUS authentication + CoA for MikroTik

- [ ] **Step 1: Create src/services/radiusServer.js**

```javascript
const dgram = require('dgram');
const crypto = require('crypto');
const { sessions, users, packages, devices, logs } = require('../db');
const config = require('../config');

const server = dgram.createSocket('udp4');

// RADIUS packet types
const ACCESS_REQUEST = 1;
const ACCESS_ACCEPT = 2;
const ACCESS_REJECT = 3;
const ACCOUNTING_REQUEST = 4;
const ACCOUNTING_RESPONSE = 5;
const COA_REQUEST = 37;
const DISCONNECT_REQUEST = 40;

// Attribute types
const ATTR_USER_NAME = 1;
const ATTR_USER_PASSWORD = 2;
const ATTR_NAS_IP = 4;
const ATTR_SESSION_TIMEOUT = 27;
const ATTR_IDLE_TIMEOUT = 28;
const ATTR_ACCT_SESSION_ID = 44;
const ATTR_ACCT_STATUS = 40;
const ATTR_ACCT_INPUT_OCTETS = 42;
const ATTR_ACCT_OUTPUT_OCTETS = 43;
const ATTR_WISPR_BANDWIDTH_MAX_DOWN = 231;
const ATTR_WISPR_BANDWIDTH_MAX_UP = 232;
const ATTR_WISPR_QUOTA_LIMIT = 23256;

function parsePacket(buffer) {
  const code = buffer.readUInt8(0);
  const id = buffer.readUInt8(1);
  const length = buffer.readUInt16BE(2);
  const authenticator = buffer.slice(4, 20);
  const attributes = parseAttributes(buffer.slice(20));
  
  return { code, id, length, authenticator, attributes };
}

function parseAttributes(buffer) {
  const attrs = {};
  let offset = 0;
  
  while (offset < buffer.length) {
    const type = buffer.readUInt8(offset);
    const len = buffer.readUInt8(offset + 1);
    const value = buffer.slice(offset + 2, offset + len);
    
    if (type === ATTR_USER_NAME) attrs.username = value.toString();
    else if (type === ATTR_USER_PASSWORD) attrs.password = value;
    else if (type === ATTR_ACCT_SESSION_ID) attrs.sessionId = value.toString();
    else if (type === ATTR_ACCT_STATUS) attrs.acctStatusType = value.readUInt32BE(0);
    else if (type === ATTR_ACCT_INPUT_OCTETS) attrs.inputOctets = value.readUIntBE(0, 6);
    else if (type === ATTR_ACCT_OUTPUT_OCTETS) attrs.outputOctets = value.readUIntBE(0, 6);
    else if (type === ATTR_NAS_IP) attrs.nasIp = value.join('.');
    
    offset += len;
  }
  
  return attrs;
}

function createAccessAccept(id, reqAuth, attrs = {}) {
  const response = Buffer.alloc(20 + 100);
  response.writeUInt8(ACCESS_ACCEPT, 0);
  response.writeUInt8(id, 1);
  // Length calculated later
  reqAuth.copy(response, 4); // Use request authenticator
  
  let offset = 20;
  
  // Reply-Message
  if (attrs.replyMessage) {
    const msg = Buffer.from(attrs.replyMessage);
    response.writeUInt8(ATTR_USER_NAME === 18 ? 18 : 18, offset);
    response.writeUInt8(3 + msg.length, offset + 1);
    msg.copy(response, offset + 2);
    offset += 3 + msg.length;
  }
  
  // Session-Timeout
  if (attrs.sessionTimeout) {
    response.writeUInt8(ATTR_SESSION_TIMEOUT, offset);
    response.writeUInt8(6, offset + 1);
    response.writeUInt32BE(attrs.sessionTimeout, offset + 2);
    offset += 6;
  }
  
  // Idle-Timeout
  if (attrs.idleTimeout) {
    response.writeUInt8(ATT_IDLE_TIMEOUT, offset);
    response.writeUInt8(6, offset + 1);
    response.writeUInt32BE(attrs.idleTimeout, offset + 2);
    offset += 6;
  }
  
  // WISPr Bandwidth
  if (attrs.bandwidthDown) {
    // ... add WISPr attributes
  }
  
  response.writeUInt16BE(offset, 2);
  return response.slice(0, offset);
}

function authenticateUser(username, password) {
  // Check local users
  const user = users.getByIdentifier.get(username);
  if (user && user.password_hash) {
    return bcrypt.compare(password, user.password_hash).then(valid => ({
      valid,
      user,
    }));
  }
  return Promise.resolve({ valid: false, user: null });
}

server.on('message', async (msg, rinfo) => {
  const packet = parsePacket(msg);
  
  if (packet.code === ACCESS_REQUEST) {
    const { username, password } = packet.attributes;
    
    try {
      const { valid, user } = await authenticateUser(username, password);
      
      if (valid && user) {
        // Get user's package or default
        const pkg = packages.getActive.get ? packages.getActive.get(1) : packages.getActive.all()[0];
        
        // Create session
        const sessionId = crypto.randomUUID();
        sessions.create.run({
          user_id: user.id,
          package_id: pkg?.id || null,
          mac_address: '', // From NAS
          ip_address: rinfo.address,
          nas_identifier: packet.attributes.nasIp,
          username,
          session_id: sessionId,
          quota_total_mb: pkg?.quota_mb || null,
          bandwidth_down_kbps: pkg?.bandwidth_down_kbps || 5000,
          bandwidth_up_kbps: pkg?.bandwidth_up_kbps || 2000,
        });
        
        // Update device
        const existingDevice = devices.getByUser.get(user.id);
        if (existingDevice) {
          devices.updateOnline.run({
            is_online: 1,
            session_id: sessionId,
            mac_address: existingDevice.mac_address,
          });
        }
        
        const response = createAccessAccept(packet.id, packet.authenticator, {
          sessionTimeout: (pkg?.duration_minutes || 60) * 60,
          idleTimeout: 300,
          bandwidthDown: pkg?.bandwidth_down_kbps || 5000,
        });
        
        server.send(response, rinfo.port, rinfo.address);
      } else {
        const response = Buffer.alloc(20);
        response.writeUInt8(ACCESS_REJECT, 0);
        response.writeUInt8(packet.id, 1);
        response.writeUInt16BE(20, 2);
        packet.authenticator.copy(response, 4);
        server.send(response, rinfo.port, rinfo.address);
      }
    } catch (err) {
      console.error('RADIUS auth error:', err);
    }
  }
  
  if (packet.code === ACCOUNTING_REQUEST) {
    const { sessionId, acctStatusType, inputOctets, outputOctets } = packet.attributes;
    
    if (acctStatusType === 1) { // Start
      // Session started
    } else if (acctStatusType === 2) { // Stop
      const session = sessions.getBySessionId.get(sessionId);
      if (session) {
        sessions.update.run({
          ...session,
          is_active: 0,
          terminated_by: 'user',
          end_time: new Date().toISOString(),
        });
        devices.setOffline.run(session.mac_address);
      }
    } else if (acctStatusType === 3) { // Interim
      // Update session activity and quota
      const session = sessions.getBySessionId.get(sessionId);
      if (session) {
        sessions.update.run({
          ...session,
          last_activity: new Date().toISOString(),
          quota_used_mb: Math.floor((inputOctets + outputOctets) / (1024 * 1024)),
        });
      }
    }
    
    // Send Accounting-Response
    const response = Buffer.alloc(20);
    response.writeUInt8(ACCOUNTING_RESPONSE, 0);
    response.writeUInt8(packet.id, 1);
    response.writeUInt16BE(20, 2);
    server.send(response, rinfo.port, rinfo.address);
  }
});

function start(port = config.radiusCoaPort) {
  server.bind(port, () => {
    console.log(`RADIUS server listening on port ${port}`);
  });
}

module.exports = { start, server };
```

- [ ] **Step 2: Create src/services/radiusClient.js (CoA sender)**

```javascript
const dgram = require('dgram');
const crypto = require('crypto');
const config = require('../config');

async function sendCoA(nasIp, attributes) {
  return new Promise((resolve, reject) => {
    const client = dgram.createSocket('udp4');
    const id = Math.floor(Math.random() * 256);
    
    // Build CoA-Request packet
    const packet = buildCoAPacket(id, attributes);
    
    client.send(packet, 3799, nasIp, (err) => {
      if (err) {
        client.close();
        return reject(err);
      }
    });
    
    client.on('message', (msg) => {
      const code = msg.readUInt8(0);
      client.close();
      
      if (code === 44) { // CoA-ACK
        resolve({ success: true });
      } else if (code === 45) { // CoA-NACK
        resolve({ success: false, error: 'CoA rejected' });
      }
    });
    
    client.on('error', reject);
    
    setTimeout(() => {
      client.close();
      reject(new Error('CoA timeout'));
    }, 5000);
  });
}

function buildCoAPacket(id, attrs) {
  // Build CoA-Request packet
  // Type 37, ID, Length, Request Authenticator
  // Attributes for session management
}

async function disconnectSession(sessionId, nasIp) {
  return sendCoA(nasIp, {
    'Acct-Session-Id': sessionId,
  });
}

async function changeBandwidth(sessionId, nasIp, downKbps, upKbps) {
  return sendCoA(nasIp, {
    'Acct-Session-Id': sessionId,
    'WISPr-Bandwidth-Max-Down': downKbps,
    'WISPr-Bandwidth-Max-Up': upKbps,
  });
}

module.exports = { sendCoA, disconnectSession, changeBandwidth };
```

- [ ] **Step 3: Update src/index.js**

```javascript
const { start: startRadius } = require('./services/radiusServer');

// After app.listen
startRadius(config.radiusCoaPort);
```

- [ ] **Step 4: Commit**

```bash
git add src/services/radiusServer.js src/services/radiusClient.js src/index.js
git commit -m "feat(radius): add RADIUS server and CoA client"
```

---

## Task 3: Session Manager with Activity Tracking

**Files:**
- Create: `src/services/sessionManager.js`
- Modify: `src/services/radiusServer.js`

**Interfaces:**
- Produces: Activity-based session timer, device limit enforcement

- [ ] **Step 1: Create src/services/sessionManager.js**

```javascript
const { sessions, devices, users, packages } = require('../db');
const { disconnectSession } = require('./radiusClient');

const ACTIVITY_THRESHOLD = 1024; // bytes
const IDLE_CHECK_INTERVAL = 60 * 1000; // 1 minute

let idleCheckTimer = null;

function startIdleChecker() {
  if (idleCheckTimer) return;
  
  idleCheckTimer = setInterval(() => {
    checkIdleSessions();
  }, IDLE_CHECK_INTERVAL);
}

function stopIdleChecker() {
  if (idleCheckTimer) {
    clearInterval(idleCheckTimer);
    idleCheckTimer = null;
  }
}

function checkIdleSessions() {
  const activeSessions = sessions.getActive.all();
  
  for (const session of activeSessions) {
    const idleSeconds = session.idle_seconds || 0;
    const durationMinutes = Math.floor(
      (Date.now() - new Date(session.start_time).getTime()) / 60000
    );
    
    // Check if session expired by duration
    const maxDuration = (session.package?.duration_minutes || 60) * 60;
    if (durationMinutes * 60 >= maxDuration) {
      terminateSession(session, 'expired');
      continue;
    }
    
    // Check quota if set
    if (session.quota_total_mb && session.quota_used_mb >= session.quota_total_mb) {
      terminateSession(session, 'quota');
      continue;
    }
    
    // Check if idle too long
    const idleTimeout = 300; // 5 minutes default
    if (idleSeconds >= idleTimeout) {
      terminateSession(session, 'idle');
    }
  }
}

async function terminateSession(session, reason) {
  sessions.update.run({
    ...session,
    is_active: 0,
    terminated_by: reason,
    end_time: new Date().toISOString(),
  });
  
  devices.setOffline.run(session.mac_address);
  
  // Send CoA disconnect
  if (session.nas_identifier) {
    try {
      await disconnectSession(session.session_id, session.nas_identifier);
    } catch (err) {
      console.error('Failed to send CoA disconnect:', err);
    }
  }
}

async function handleNewConnection(userId, macAddress, nasIp) {
  const user = users.getById.get(userId);
  if (!user) throw new Error('User not found');
  
  // Check device limit
  const onlineDevices = devices.getOnlineByUser.all(userId);
  if (onlineDevices.length >= user.max_devices) {
    // Kick oldest device
    const oldest = onlineDevices.reduce((a, b) =>
      a.first_seen < b.first_seen ? a : b
    );
    
    // Get session for that device
    const session = sessions.getById.get(oldest.session_id);
    if (session) {
      console.log(`Kicking oldest device: ${oldest.device_name || oldest.mac_address}`);
      await terminateSession(session, 'device_limit');
    }
  }
  
  // Register new device
  devices.create.run({
    user_id: userId,
    mac_address: macAddress,
    device_name: macAddress,
    session_id: null,
  });
  
  devices.updateOnline.run({
    is_online: 1,
    session_id: null,
    mac_address: macAddress,
  });
}

function updateSessionActivity(sessionId, inputOctets, outputOctets) {
  const session = sessions.getBySessionId.get(sessionId);
  if (!session) return;
  
  const trafficDelta = inputOctets + outputOctets - (session.last_bytes || 0);
  
  if (trafficDelta > ACTIVITY_THRESHOLD) {
    // User is active - pause idle timer
    sessions.update.run({
      ...session,
      idle_seconds: 0,
      last_activity: new Date().toISOString(),
      quota_used_mb: Math.floor((inputOctets + outputOctets) / (1024 * 1024)),
    });
  } else {
    // User is idle - increment idle counter
    sessions.update.run({
      ...session,
      idle_seconds: (session.idle_seconds || 0) + 60,
    });
  }
}

module.exports = {
  startIdleChecker,
  stopIdleChecker,
  handleNewConnection,
  updateSessionActivity,
  terminateSession,
};
```

- [ ] **Step 2: Integrate into radiusServer.js**

Add call to sessionManager when handling accounting packets.

- [ ] **Step 3: Commit**

```bash
git add src/services/sessionManager.js
git commit -m "feat(session): add activity-based session management"
```

---

## Task 4: API Endpoints for Session Management

**Files:**
- Create: `src/routes/api/sessions.js`
- Create: `src/routes/api/devices.js`
- Modify: `src/app.js`

**Interfaces:**
- Produces: Admin API for session/device management

- [ ] **Step 1: Create src/routes/api/sessions.js**

```javascript
const express = require('express');
const { sessions, users } = require('../../db');
const { requireApiAuth } = require('../../middleware/auth');
const { terminateSession } = require('../../services/sessionManager');

const router = express.Router();

router.get('/', requireApiAuth, (req, res) => {
  const activeSessions = sessions.getActive.all();
  res.json(activeSessions);
});

router.get('/history', requireApiAuth, (req, res) => {
  const { limit = 100 } = req.query;
  const history = db.prepare(`
    SELECT * FROM sessions ORDER BY start_time DESC LIMIT ?
  `).all(limit);
  res.json(history);
});

router.delete('/:id', requireApiAuth, async (req, res) => {
  const session = sessions.getById.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  await terminateSession(session, 'admin');
  res.json({ success: true });
});

module.exports = router;
```

- [ ] **Step 2: Create src/routes/api/devices.js**

```javascript
const express = require('express');
const { devices, sessions } = require('../../db');
const { requireApiAuth } = require('../../middleware/auth');
const { terminateSession } = require('../../services/sessionManager');

const router = express.Router();

router.get('/', requireApiAuth, (req, res) => {
  const allDevices = db.prepare(`
    SELECT d.*, s.username 
    FROM devices d 
    LEFT JOIN sessions s ON d.session_id = s.id
    ORDER BY d.last_seen DESC
  `).all();
  res.json(allDevices);
});

router.delete('/:mac', requireApiAuth, async (req, res) => {
  const device = devices.getByMac.get(req.params.mac);
  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }
  
  // Get session and terminate
  if (device.session_id) {
    const session = sessions.getById.get(device.session_id);
    if (session) {
      await terminateSession(session, 'admin');
    }
  }
  
  devices.setOffline.run(req.params.mac);
  res.json({ success: true });
});

module.exports = router;
```

- [ ] **Step 3: Mount in src/app.js**

```javascript
app.use('/api/sessions', require('./routes/api/sessions'));
app.use('/api/devices', require('./routes/api/devices'));
```

- [ ] **Step 4: Commit**

```bash
git add src/routes/api/sessions.js src/routes/api/devices.js src/app.js
git commit -m "feat(api: add session and device management endpoints"
```

---

## Task 5: OAuth Whitelist API

**Files:**
- Create: `src/routes/api/users.js`
- Modify: `src/app.js`

**Interfaces:**
- Produces: Admin API for user and whitelist management

- [ ] **Step 1: Create src/routes/api/users.js**

```javascript
const express = require('express');
const bcrypt = require('bcryptjs');
const { users, oauth } = require('../../db');
const { requireApiAuth } = require('../../middleware/auth');

const router = express.Router();

// List users
router.get('/', requireApiAuth, (req, res) => {
  const allUsers = users.getAll.all();
  res.json(allUsers);
});

// Create local user
router.post('/', requireApiAuth, async (req, res) => {
  const { username, password, email, max_devices } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  
  const passwordHash = await bcrypt.hash(password, 12);
  
  const result = users.create.run({
    type: 'local',
    identifier: username,
    email: email || null,
    password_hash: passwordHash,
    display_name: username,
    max_devices: max_devices || 3,
  });
  
  res.json({ id: result.lastInsertRowid, username });
});

// Update user
router.put('/:id', requireApiAuth, (req, res) => {
  const user = users.getById.get(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  const { email, max_devices, is_active } = req.body;
  
  users.update.run({
    id: req.params.id,
    email: email || user.email,
    display_name: user.display_name,
    max_devices: max_devices !== undefined ? max_devices : user.max_devices,
    is_active: is_active !== undefined ? (is_active ? 1 : 0) : user.is_active,
  });
  
  res.json({ success: true });
});

// Delete user
router.delete('/:id', requireApiAuth, (req, res) => {
  users.delete.run(req.params.id);
  res.json({ success: true });
});

// Add to OAuth whitelist
router.post('/:id/whitelist', requireApiAuth, (req, res) => {
  const { google_email } = req.body;
  
  if (!google_email) {
    return res.status(400).json({ error: 'Email required' });
  }
  
  try {
    oauth.create.run({
      user_id: req.params.id,
      google_email,
      allowed_by: req.session.adminId,
    });
    res.json({ success: true });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Email already whitelisted' });
    }
    throw err;
  }
});

// Remove from OAuth whitelist
router.delete('/:id/whitelist/:email', requireApiAuth, (req, res) => {
  const entry = oauth.getByEmail.get(req.params.email);
  if (entry && entry.user_id === parseInt(req.params.id)) {
    oauth.delete.run(entry.id);
  }
  res.json({ success: true });
});

module.exports = router;
```

- [ ] **Step 2: Mount in src/app.js**

```javascript
app.use('/api/users', require('./routes/api/users'));
```

- [ ] **Step 3: Commit**

```bash
git add src/routes/api/users.js src/app.js
git commit -m "feat(api: add user management and OAuth whitelist"
```

---

## Task 6: Phase 2 Verification

**Files:** None (testing)

- [ ] **Step 1: Start server**

```bash
npm start
# Server should start with RADIUS on UDP 3799
```

- [ ] **Step 2: Test OAuth route exists**

```bash
curl -I http://localhost:3000/auth/google
# Should redirect to Google OAuth
```

- [ ] **Step 3: Test session API**

```bash
curl http://localhost:3000/api/sessions
# Should require auth or return empty array
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(phase2): RADIUS, OAuth, session management"
git tag phase2-complete
```

---

## Phase 2 Summary

**Completed:**
- Google OAuth with passport.js
- RADIUS server for MikroTik authentication
- CoA client for session control
- Activity-based session tracking
- Device limit enforcement with auto-kick
- Session and device management APIs
- User management with OAuth whitelist

**Next (Phase 3):**
- Admin Dashboard SPA
- Reports and analytics
- WebDAV backup system
- Branding customization UI

**To Test:**
```bash
cd ~/radius-captive-portal
npm start
# Test at http://localhost:3000
```
