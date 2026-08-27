const { sessions, devices, users, packages, macAuthorizations } = require('../db');
const { disconnectSession } = require('./radiusClient');
const logger = require('../utils/logger');

const ACTIVITY_THRESHOLD = 1024; // bytes
const IDLE_CHECK_INTERVAL = 30 * 1000; // 30 seconds

let idleCheckTimer = null;

function startIdleChecker() {
  if (idleCheckTimer) return;

  idleCheckTimer = setInterval(() => {
    checkIdleSessions();
  }, IDLE_CHECK_INTERVAL);
  logger.info('Session idle & expiry checker started');
}

function stopIdleChecker() {
  if (idleCheckTimer) {
    clearInterval(idleCheckTimer);
    idleCheckTimer = null;
    logger.info('Session idle & expiry checker stopped');
  }
}

function checkIdleSessions() {
  try {
    // Purge expired MAC authorizations from SQLite
    macAuthorizations.deleteExpired.run();

    const activeSessions = sessions.getActive.all();

    for (const session of activeSessions) {
      const idleSeconds = session.idle_seconds || 0;
      const durationSeconds = Math.floor(
        (Date.now() - new Date(session.start_time).getTime()) / 1000
      );

      // Check package duration if linked
      let maxDurationSeconds = 24 * 60 * 60; // 24 hours default
      if (session.package_id) {
        const pkg = packages.getById.get(session.package_id);
        if (pkg?.duration_minutes) {
          maxDurationSeconds = pkg.duration_minutes * 60;
        }
      }

      // Check if session expired by duration
      if (durationSeconds >= maxDurationSeconds) {
        logger.info(`Session ${session.session_id} expired by duration limit (${durationSeconds}s / ${maxDurationSeconds}s)`);
        terminateSession(session, 'duration_expired');
        continue;
      }

      // Check if MAC authorization expired
      if (session.mac_address) {
        const auth = macAuthorizations.get.get(session.mac_address);
        if (auth && new Date(auth.expires_at).getTime() <= Date.now()) {
          const reason = auth.access_type === 'oauth_grace' ? 'oauth_grace_expired' : 'mac_auth_expired';
          logger.info(`Session ${session.session_id} expired by MAC authorization time (${reason})`);
          terminateSession(session, reason);
          continue;
        }
      }

      // Check quota if set
      if (session.quota_total_mb && (session.quota_used_mb || 0) >= session.quota_total_mb) {
        logger.info(`Session ${session.session_id} exceeded quota (${session.quota_used_mb}MB / ${session.quota_total_mb}MB)`);
        terminateSession(session, 'quota_exceeded');
        continue;
      }

      // Check if idle too long (5 minutes default)
      const idleTimeout = 300;
      if (idleSeconds >= idleTimeout) {
        logger.info(`Session ${session.session_id} idle timed out (${idleSeconds}s)`);
        terminateSession(session, 'idle_timeout');
      }
    }
  } catch (err) {
    logger.error('Error during checkIdleSessions:', err);
  }
}

async function terminateSession(session, reason) {
  if (!session) return;

  logger.info(`Terminating session ${session.session_id} (Reason: ${reason})`);

  sessions.update.run({
    ...session,
    is_active: 0,
    terminated_by: reason,
    end_time: new Date().toISOString(),
  });

  if (session.mac_address) {
    devices.setOffline.run(session.mac_address);
  }

  // Send RADIUS Disconnect-Request to NAS
  const nasIp = session.nas_identifier || session.ip_address;
  if (nasIp && nasIp !== '0.0.0.0') {
    try {
      const result = await disconnectSession({
        sessionId: session.session_id,
        nasIp,
        username: session.username,
        macAddress: session.mac_address,
        ipAddress: session.ip_address,
      });

      if (!result.success) {
        logger.warn(`Disconnect-Request to router ${nasIp} for session ${session.session_id} returned: ${result.error}`);
      } else {
        logger.info(`Successfully sent Disconnect-Request to router ${nasIp} for session ${session.session_id}`);
      }
    } catch (err) {
      logger.error(`Failed to send Disconnect-Request to router ${nasIp}:`, err);
    }
  }
}

async function handleNewConnection(userId, macAddress, nasIp) {
  const user = users.getById.get(userId);
  if (!user) return;

  // Check device limit for user
  const maxDevices = user.max_devices || 3;
  const onlineDevices = devices.getOnlineByUser.all(userId);

  if (onlineDevices.length >= maxDevices) {
    // Find oldest active device
    const oldest = onlineDevices.reduce((a, b) =>
      new Date(a.first_seen).getTime() < new Date(b.first_seen).getTime() ? a : b
    );

    if (oldest.session_id) {
      const session = sessions.getById.get(oldest.session_id);
      if (session && session.is_active) {
        logger.info(`Device limit reached for user ${user.identifier}. Kicking oldest session ${session.session_id}`);
        await terminateSession(session, 'device_limit');
      }
    }
  }
}

function updateSessionActivity(sessionId, inputOctets, outputOctets) {
  const session = sessions.getBySessionId.get(sessionId);
  if (!session) return;

  const currentTotalBytes = inputOctets + outputOctets;
  const lastTotalBytes = (session.last_bytes || 0);
  const trafficDelta = currentTotalBytes - lastTotalBytes;

  if (trafficDelta > ACTIVITY_THRESHOLD) {
    // User is active - reset idle counter
    sessions.update.run({
      ...session,
      idle_seconds: 0,
      last_activity: new Date().toISOString(),
      quota_used_mb: Math.floor(currentTotalBytes / (1024 * 1024)),
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
  checkIdleSessions,
};

