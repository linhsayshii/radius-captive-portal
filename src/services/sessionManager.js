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
