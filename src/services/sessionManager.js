const { sessions, devices, users, packages, macAuthorizations } = require('../db');
const { disconnectSession } = require('./radiusClient');
const { getAccessPolicy } = require('./accessPolicy');
const logger = require('../utils/logger');

const ACTIVITY_THRESHOLD = 1024; // bytes
const IDLE_CHECK_INTERVAL = 30 * 1000; // 30 seconds

let idleCheckTimer = null;

// SQLite CURRENT_TIMESTAMP is UTC but is returned as "YYYY-MM-DD HH:mm:ss"
// without a timezone suffix. Node treats that bare format as local time, which
// made new sessions appear seven hours old in Vietnam and expire immediately.
function toTimestampMs(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return Date.parse(`${value.replace(' ', 'T')}Z`);
  }
  return new Date(value).getTime();
}

function startIdleChecker() {
  if (idleCheckTimer) return;

  idleCheckTimer = setInterval(() => {
    void checkIdleSessions();
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

async function checkIdleSessions() {
  try {
    const activeSessions = sessions.getActive.all();

    for (const session of activeSessions) {
      const idleSeconds = session.idle_seconds || 0;
      const durationSeconds = Math.floor(
        (Date.now() - toTimestampMs(session.start_time)) / 1000
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
        await terminateSession(session, 'duration_expired', { allowLocalTermination: true });
        continue;
      }

      // Check if MAC authorization expired
      if (session.mac_address) {
        const auth = macAuthorizations.get.get(session.mac_address);
        if (auth && new Date(auth.expires_at).getTime() <= Date.now()) {
          const reason = auth.access_type === 'oauth_grace' ? 'oauth_grace_expired' : 'mac_auth_expired';
          logger.info(`Session ${session.session_id} expired by MAC authorization time (${reason})`);
          await terminateSession(session, reason, { allowLocalTermination: true });
          continue;
        }
      }

      // Check quota if set
      if (session.quota_total_mb && (session.quota_used_mb || 0) >= session.quota_total_mb) {
        logger.info(`Session ${session.session_id} exceeded quota (${session.quota_used_mb}MB / ${session.quota_total_mb}MB)`);
        await terminateSession(session, 'quota_exceeded', { allowLocalTermination: true });
        continue;
      }

      // Check if idle too long (5 minutes default)
      const idleTimeout = 300;
      if (idleSeconds >= idleTimeout) {
        logger.info(`Session ${session.session_id} idle timed out (${idleSeconds}s)`);
        await terminateSession(session, 'idle_timeout', { allowLocalTermination: true });
      }
    }

    // Remove stale authorizations only after active sessions have had a chance
    // to observe the expiry and issue a Disconnect-Request to their NAS.
    macAuthorizations.deleteExpired.run();
  } catch (err) {
    logger.error('Error during checkIdleSessions:', err);
  }
}

async function terminateSession(session, reason, { allowLocalTermination = false } = {}) {
  if (!session) return { success: false, error: 'Không tìm thấy phiên kết nối' };

  logger.info(`Terminating session ${session.session_id} (Reason: ${reason})`);

  // Send RADIUS Disconnect-Request to NAS
  const nasIp = session.nas_identifier || session.ip_address;
  let disconnect = { attempted: false, success: false };
  if (nasIp && nasIp !== '0.0.0.0' && nasIp !== 'unknown') {
    disconnect.attempted = true;
    try {
      const result = await disconnectSession({
        sessionId: session.session_id,
        nasIp,
        username: session.username,
        macAddress: session.mac_address,
        ipAddress: session.ip_address,
      });

      disconnect = { attempted: true, ...result };
      if (!result.success) {
        logger.warn(`Disconnect-Request to router ${nasIp} for session ${session.session_id} returned: ${result.error}`);
        return { success: false, error: result.error || 'Router không xác nhận lệnh ngắt kết nối', disconnect };
      } else {
        logger.info(`Successfully sent Disconnect-Request to router ${nasIp} for session ${session.session_id}`);
      }
    } catch (err) {
      logger.error(`Failed to send Disconnect-Request to router ${nasIp}:`, err);
      return { success: false, error: err.message, disconnect };
    }
  } else if (!allowLocalTermination) {
    return { success: false, error: 'Không có địa chỉ NAS hợp lệ để ngắt thiết bị', disconnect };
  }

  sessions.update.run({
    ...session,
    is_active: 0,
    terminated_by: reason,
    end_time: new Date().toISOString(),
  });

  if (session.mac_address) {
    devices.setOffline.run(session.mac_address);
  }

  removeLiveMetric(session.session_id);
  return { success: true, disconnect, localOnly: !disconnect.attempted };
}

async function handleNewConnection(userId, macAddress, nasIp) {
  const user = users.getById.get(userId);
  if (!user) return;

  // Check device limit for user
  const policy = getAccessPolicy(user);
  const maxDevices = policy.maxDevices;
  const onlineDevices = devices.getOnlineByUser.all(userId);

  // The device that just connected is already online, so enforce only when it
  // pushes the count beyond the limit. Using >= disconnected a user's first
  // device whenever max_devices was 1.
  if (onlineDevices.length > maxDevices) {
    // Find oldest active device
    const oldest = onlineDevices.reduce((a, b) =>
      toTimestampMs(a.first_seen) < toTimestampMs(b.first_seen) ? a : b
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

// In-memory store for live session metrics
const liveMetrics = new Map();

function updateSessionActivity(sessionId, inputOctets, outputOctets) {
  const session = sessions.getBySessionId.get(sessionId);
  if (!session) return;

  const now = Date.now();
  const currentTotalBytes = inputOctets + outputOctets;
  let metric = liveMetrics.get(sessionId);

  let rateDownKbps = 0;
  let rateUpKbps = 0;
  let bytesChanged = false;

  if (metric) {
    const elapsedSec = Math.max(1, (now - metric.lastTimestamp) / 1000);
    const inDelta = Math.max(0, inputOctets - metric.lastInputOctets);
    const outDelta = Math.max(0, outputOctets - metric.lastOutputOctets);
    bytesChanged = inDelta + outDelta >= ACTIVITY_THRESHOLD;

    rateDownKbps = Math.round((inDelta * 8) / (elapsedSec * 1024));
    rateUpKbps = Math.round((outDelta * 8) / (elapsedSec * 1024));

    metric.lastInputOctets = inputOctets;
    metric.lastOutputOctets = outputOctets;
    metric.lastTimestamp = now;
    metric.rateDownKbps = rateDownKbps;
    metric.rateUpKbps = rateUpKbps;
    metric.totalInputBytes = inputOctets;
    metric.totalOutputBytes = outputOctets;
  } else {
    metric = {
      lastInputOctets: inputOctets,
      lastOutputOctets: outputOctets,
      lastTimestamp: now,
      rateDownKbps: 0,
      rateUpKbps: 0,
      totalInputBytes: inputOctets,
      totalOutputBytes: outputOctets,
    };
    liveMetrics.set(sessionId, metric);
  }

  const isTransmitting = rateDownKbps > 0 || rateUpKbps > 0 || bytesChanged;

  if (isTransmitting) {
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

function getLiveMetrics(sessionId) {
  const metric = liveMetrics.get(sessionId);
  if (!metric) {
    return { rateDownKbps: 0, rateUpKbps: 0, totalInputBytes: 0, totalOutputBytes: 0 };
  }
  const isStale = (Date.now() - metric.lastTimestamp) > 120000;
  return {
    rateDownKbps: isStale ? 0 : metric.rateDownKbps,
    rateUpKbps: isStale ? 0 : metric.rateUpKbps,
    totalInputBytes: metric.totalInputBytes,
    totalOutputBytes: metric.totalOutputBytes,
  };
}

function getTotalLiveBandwidth() {
  const activeSessions = sessions.getActive.all();
  let totalDownKbps = 0;
  let totalUpKbps = 0;

  for (const s of activeSessions) {
    if (s.session_id) {
      const metric = getLiveMetrics(s.session_id);
      totalDownKbps += metric.rateDownKbps;
      totalUpKbps += metric.rateUpKbps;
    }
  }

  const totalDownMbps = Number((totalDownKbps / 1024).toFixed(2));
  const totalUpMbps = Number((totalUpKbps / 1024).toFixed(2));
  const totalBandwidthMbps = Number(((totalDownKbps + totalUpKbps) / 1024).toFixed(2));

  return {
    totalDownKbps,
    totalUpKbps,
    totalDownMbps,
    totalUpMbps,
    totalBandwidthMbps,
  };
}

function removeLiveMetric(sessionId) {
  if (sessionId) {
    liveMetrics.delete(sessionId);
  }
}

module.exports = {
  startIdleChecker,
  stopIdleChecker,
  handleNewConnection,
  updateSessionActivity,
  terminateSession,
  checkIdleSessions,
  getLiveMetrics,
  getTotalLiveBandwidth,
  removeLiveMetric,
  toTimestampMs,
};
