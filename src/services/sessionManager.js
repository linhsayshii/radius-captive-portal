const { sessions, devices, users, packages, macAuthorizations } = require('../db');
const { disconnectSession, expireSession } = require('./radiusClient');
const { getAccessPolicy } = require('./accessPolicy');
const logger = require('../utils/logger');

const ACTIVITY_THRESHOLD = 1024; // bytes
const IDLE_CHECK_INTERVAL = 30 * 1000; // 30 seconds
// A manual kick must revoke the MAC grant as well as terminate the active
// HotSpot session. Otherwise RouterOS can immediately authenticate the same
// MAC again from the still-present RADIUS policy, bypassing captive portal.
const REVOCATION_REASONS = new Set([
  'duration_expired',
  'quota_exceeded',
  'mac_auth_expired',
  'admin_revoked_mac',
  'admin_test_kick',
  'admin',
  'admin_device_kick',
  'device_limit',
]);

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

      // Package sessions have a duration. An account with no selected package
      // is intentionally not converted to the old 24-hour default policy.
      let maxDurationSeconds = null;
      if (session.package_id) {
        const pkg = packages.getById.get(session.package_id);
        if (pkg?.duration_minutes) {
          maxDurationSeconds = pkg.duration_minutes * 60;
        }
      } else if (session.user_id) {
        const user = users.getById.get(session.user_id);
        if (user) {
          maxDurationSeconds = getAccessPolicy(user).durationSeconds;
        }
      }

      // Check if session expired by duration
      if (maxDurationSeconds && durationSeconds >= maxDurationSeconds) {
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
    const { queueExpiredAuthorizationRemoval } = require('./radiusSync');
    queueExpiredAuthorizationRemoval();
    try {
      const { macWhitelist } = require('../routes/api/guest');
      for (const [mac, data] of macWhitelist.entries()) {
        if (new Date(data.expires_at) <= new Date()) macWhitelist.delete(mac);
      }
    } catch (_) {}
  } catch (err) {
    logger.error('Error during checkIdleSessions:', err);
  }
}

async function terminateSession(session, reason, { allowLocalTermination = false } = {}) {
  if (!session) return { success: false, error: 'Không tìm thấy phiên kết nối' };

  logger.info(`Terminating session ${session.session_id} (Reason: ${reason})`);

  // A manual dashboard kick follows RouterOS's Session-Timeout path, which
  // mirrors a naturally expired account and prompts captive re-detection on
  // supported clients. Other termination reasons use Disconnect-Request.
  const nasIp = session.nas_identifier || session.ip_address;
  let disconnect = { attempted: false, success: false };
  if (nasIp && nasIp !== '0.0.0.0' && nasIp !== 'unknown') {
    disconnect.attempted = true;
    try {
      const target = {
        sessionId: session.session_id,
        nasIp,
        username: session.username,
        macAddress: session.mac_address,
        ipAddress: session.ip_address,
        nasPort: session.nas_port,
        nasPortType: session.nas_port_type,
        nasPortId: session.nas_port_id,
        calledStationId: session.called_station_id,
      };
      const shouldExpireViaRouter = reason === 'admin' || reason === 'admin_device_kick';
      let result = shouldExpireViaRouter
        ? await expireSession(target, 1)
        : await disconnectSession(target);

      if (!result.success && shouldExpireViaRouter) {
        logger.warn(`Router did not accept CoA Session-Timeout for ${session.session_id}; falling back to Disconnect-Request`, {
          error: result.error,
        });
        result = await disconnectSession(target);
      }

      disconnect = { attempted: true, ...result };
      if (!result.success) {
        logger.warn(`Disconnect-Request to router ${nasIp} for session ${session.session_id} returned: ${result.error}`);
        if (!allowLocalTermination) {
          return { success: false, error: result.error || 'Router không xác nhận lệnh ngắt kết nối', disconnect };
        }
      } else {
        logger.info(`Successfully sent Disconnect-Request to router ${nasIp} for session ${session.session_id}`);
      }
    } catch (err) {
      logger.error(`Failed to send Disconnect-Request to router ${nasIp}:`, err);
      if (!allowLocalTermination) {
        return { success: false, error: err.message, disconnect };
      }
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
    try {
      const { macWhitelist } = require('../routes/api/guest');
      macWhitelist.delete(session.mac_address);
    } catch (_) {}
    if (REVOCATION_REASONS.has(reason)) {
      macAuthorizations.delete.run(session.mac_address);
      try {
        // Do not wait for the 30-second outbox worker here. A client that is
        // kicked from the dashboard can probe the network immediately; the
        // RADIUS row must already be gone so the probe enters captive portal.
        await require('./radiusSync').removeMacFromRadius(session.mac_address);
      } catch (error) {
        logger.error('Unable to revoke FreeRADIUS policy after session termination', {
          macAddress: session.mac_address,
          reason,
          error: error.message,
        });
        if (!allowLocalTermination) {
          return {
            success: false,
            error: 'Đã ngắt phiên trên Router nhưng chưa thể thu hồi quyền RADIUS để yêu cầu đăng nhập lại',
            disconnect,
          };
        }
      }
    }
  }

  removeLiveMetric(session.session_id);
  return { success: true, disconnect, localOnly: !disconnect.attempted || !disconnect.success };
}

async function enforceDeviceLimit(userId, { reserveMac } = {}) {
  const user = users.getById.get(userId);
  if (!user) return { terminated: 0 };

  const policy = getAccessPolicy(user);
  const activeSessions = sessions.getActiveByUser.all(userId);
  const existingSessions = activeSessions.filter((session) => !reserveMac || session.mac_address !== reserveMac);
  const permittedExistingSessions = Math.max(0, policy.maxDevices - (reserveMac ? 1 : 0));
  const sessionsToTerminate = existingSessions
    .sort((left, right) => toTimestampMs(left.start_time) - toTimestampMs(right.start_time))
    .slice(0, Math.max(0, existingSessions.length - permittedExistingSessions));

  for (const session of sessionsToTerminate) {
    logger.info(`Device limit reached for user ${user.identifier}. Kicking oldest session ${session.session_id}`);
    await terminateSession(session, 'device_limit', { allowLocalTermination: true });
  }

  return { terminated: sessionsToTerminate.length };
}

async function handleNewConnection(userId) {
  await enforceDeviceLimit(userId);
}

// In-memory store for live session metrics
const liveMetrics = new Map();

// RADIUS Accounting direction is relative to the NAS: Input is client → NAS
// (upload) and Output is NAS → client (download).
function calculateAccountingRates(inputDelta, outputDelta, elapsedSec) {
  const seconds = Math.max(1, elapsedSec);
  return {
    rateDownKbps: Math.round((Math.max(0, outputDelta) * 8) / (seconds * 1024)),
    rateUpKbps: Math.round((Math.max(0, inputDelta) * 8) / (seconds * 1024)),
  };
}

function updateSessionActivity(sessionId, inputOctets, outputOctets) {
  const session = sessions.getBySessionId.get(sessionId);
  if (!session) return;

  const now = Date.now();
  const currentTotalBytes = inputOctets + outputOctets;
  let metric = liveMetrics.get(sessionId);

  let rateDownKbps = 0;
  let rateUpKbps = 0;
  let bytesChanged = false;
  let observedElapsedSec = 0;

  if (metric) {
    // The dashboard polls the session API more often than the NAS sends
    // Interim-Updates. Measure between counter changes, not between polls;
    // otherwise a 60-second Accounting delta is incorrectly reported as a
    // 5-second burst whenever an administrator has this page open.
    const elapsedSec = Math.max(1, (now - metric.lastTimestamp) / 1000);
    observedElapsedSec = Math.max(1, (now - metric.lastObservedTimestamp) / 1000);
    const inDelta = Math.max(0, inputOctets - metric.lastInputOctets);
    const outDelta = Math.max(0, outputOctets - metric.lastOutputOctets);
    bytesChanged = inDelta + outDelta >= ACTIVITY_THRESHOLD;

    if (inDelta > 0 || outDelta > 0) {
      ({ rateDownKbps, rateUpKbps } = calculateAccountingRates(inDelta, outDelta, elapsedSec));
      metric.lastInputOctets = inputOctets;
      metric.lastOutputOctets = outputOctets;
      metric.lastTimestamp = now;
      metric.rateDownKbps = rateDownKbps;
      metric.rateUpKbps = rateUpKbps;
    }
    metric.lastObservedTimestamp = now;
    metric.totalInputBytes = inputOctets;
    metric.totalOutputBytes = outputOctets;

    if (!bytesChanged && inDelta === 0 && outDelta === 0) {
      // Idle time must reflect real wall time. The previous fixed 30-second
      // increment expired sessions much too quickly when this endpoint was
      // refreshed every five seconds.
      sessions.update.run({
        ...session,
        idle_seconds: (session.idle_seconds || 0) + Math.round(observedElapsedSec),
      });
      return;
    }
  } else {
    metric = {
      lastInputOctets: inputOctets,
      lastOutputOctets: outputOctets,
      lastTimestamp: now,
      lastObservedTimestamp: now,
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
    // A small counter change below ACTIVITY_THRESHOLD is still observed, but
    // it does not constitute meaningful traffic for the idle policy.
    sessions.update.run({
      ...session,
      idle_seconds: (session.idle_seconds || 0) + Math.round(observedElapsedSec),
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
  enforceDeviceLimit,
  updateSessionActivity,
  terminateSession,
  checkIdleSessions,
  getLiveMetrics,
  getTotalLiveBandwidth,
  removeLiveMetric,
  toTimestampMs,
  calculateAccountingRates,
};
