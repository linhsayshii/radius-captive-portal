const { db, macAuthorizations, radiusSyncOutbox } = require('../db');
const { upsertAuthorization, removeAuthorization, getRecentAccounting } = require('./radiusPolicyStore');
const { disconnectSession } = require('./radiusClient');
const logger = require('../utils/logger');

const OUTBOX_BATCH_SIZE = 100;

function queueUpsert(macAddress) {
  radiusSyncOutbox.enqueue.run(macAddress, 'upsert');
}

function queueDelete(macAddress) {
  radiusSyncOutbox.enqueue.run(macAddress, 'delete');
}

function expirationForPolicy(connectedAt, pkg) {
  const start = new Date(connectedAt).getTime();
  const durationMinutes = pkg?.duration_minutes || (24 * 60);
  const expiresAt = new Date((Number.isFinite(start) ? start : Date.now()) + durationMinutes * 60 * 1000);
  return expiresAt.toISOString();
}

/**
 * Apply queued desired state to FreeRADIUS. A failure intentionally leaves the
 * item in SQLite so a later retry converges both stores.
 */
async function flushRadiusOutbox(limit = OUTBOX_BATCH_SIZE) {
  const pending = radiusSyncOutbox.getPending.all(limit);
  const result = { processed: 0, failed: 0, pending: pending.length };

  for (const job of pending) {
    try {
      const authorization = macAuthorizations.get.get(job.mac_address);
      if (job.operation === 'delete' || !authorization) {
        await removeAuthorization(job.mac_address);
      } else {
        await upsertAuthorization(authorization);
      }
      radiusSyncOutbox.complete.run(job.mac_address);
      result.processed += 1;
    } catch (error) {
      radiusSyncOutbox.fail.run(String(error.message || error).slice(0, 1000), job.mac_address);
      result.failed += 1;
      logger.warn('FreeRADIUS policy synchronization failed; queued for retry', {
        macAddress: job.mac_address,
        operation: job.operation,
        error: error.message,
      });
    }
  }
  return result;
}

async function synchronizeMac(macAddress) {
  queueUpsert(macAddress);
  const result = await flushRadiusOutbox(OUTBOX_BATCH_SIZE);
  const stillPending = radiusSyncOutbox.get.get(macAddress);
  if (stillPending) {
    throw new Error(stillPending.last_error || 'FreeRADIUS policy synchronization pending');
  }
  return result;
}

async function removeMacFromRadius(macAddress) {
  queueDelete(macAddress);
  const result = await flushRadiusOutbox(OUTBOX_BATCH_SIZE);
  const stillPending = radiusSyncOutbox.get.get(macAddress);
  if (stillPending) {
    throw new Error(stillPending.last_error || 'FreeRADIUS policy removal pending');
  }
  return result;
}

function applyPackageSnapshot(packageId, pkg) {
  const authorizations = macAuthorizations.getByPackage.all(packageId);
  const update = db.prepare(`UPDATE mac_authorizations SET
    bandwidth_down_kbps = ?, bandwidth_up_kbps = ?, quota_mb = ?, max_devices = ?, expires_at = ?
    WHERE mac_address = ?`);
  const transaction = db.transaction(() => {
    for (const authorization of authorizations) {
      update.run(pkg.bandwidth_down_kbps, pkg.bandwidth_up_kbps, pkg.quota_mb, pkg.max_devices,
        expirationForPolicy(authorization.connected_at, pkg), authorization.mac_address);
      queueUpsert(authorization.mac_address);
    }
  });
  transaction();
  return authorizations.map((authorization) => authorization.mac_address);
}

function revokeUserAuthorizations(userId) {
  const authorizations = macAuthorizations.getByUser.all(userId);
  const remove = db.prepare('DELETE FROM mac_authorizations WHERE mac_address = ?');
  const transaction = db.transaction(() => {
    for (const authorization of authorizations) {
      remove.run(authorization.mac_address);
      queueDelete(authorization.mac_address);
    }
  });
  transaction();
  return authorizations.map((authorization) => authorization.mac_address);
}

function applyUserPackageSnapshot(userId, pkg, maxDevices) {
  const authorizations = macAuthorizations.getByUser.all(userId);
  const update = db.prepare(`UPDATE mac_authorizations SET
    package_id = ?, bandwidth_down_kbps = ?, bandwidth_up_kbps = ?, quota_mb = ?, max_devices = ?, expires_at = ?
    WHERE mac_address = ?`);
  const transaction = db.transaction(() => {
    for (const authorization of authorizations) {
      update.run(pkg?.id || null, pkg?.bandwidth_down_kbps || 5000, pkg?.bandwidth_up_kbps || 2000,
        pkg?.quota_mb || null, pkg?.max_devices || maxDevices || 3,
        expirationForPolicy(authorization.connected_at, pkg), authorization.mac_address);
      queueUpsert(authorization.mac_address);
    }
  });
  transaction();
  return authorizations.map((authorization) => authorization.mac_address);
}

function revokePackageAuthorizations(packageId) {
  const authorizations = macAuthorizations.getByPackage.all(packageId);
  const remove = db.prepare('DELETE FROM mac_authorizations WHERE mac_address = ?');
  const transaction = db.transaction(() => {
    for (const authorization of authorizations) {
      remove.run(authorization.mac_address);
      queueDelete(authorization.mac_address);
    }
  });
  transaction();
  return authorizations.map((authorization) => authorization.mac_address);
}

function queueExpiredAuthorizationRemoval() {
  const expired = macAuthorizations.getExpired.all();
  const remove = db.prepare('DELETE FROM mac_authorizations WHERE mac_address = ?');
  const transaction = db.transaction(() => {
    for (const authorization of expired) {
      remove.run(authorization.mac_address);
      queueDelete(authorization.mac_address);
    }
  });
  transaction();
  return expired.length;
}

function queueFullReconciliation() {
  const authorizations = macAuthorizations.getAll.all();
  const transaction = db.transaction(() => {
    for (const authorization of authorizations) queueUpsert(authorization.mac_address);
  });
  transaction();
  return authorizations.length;
}

function normalizeMac(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[^0-9a-f]/gi, '').toLowerCase();
  return normalized.length === 12 ? normalized : null;
}

// A policy returned in Access-Accept cannot be changed mid-session. Disconnect
// currently active sessions so the NAS re-authenticates against the new policy.
async function disconnectActiveAuthorizations(macAddresses) {
  if (!macAddresses.length) return { attempted: 0, disconnected: 0 };
  const wanted = new Set(macAddresses);
  const accounting = await getRecentAccounting();
  let attempted = 0;
  let disconnected = 0;
  for (const record of accounting) {
    if (record.acctstoptime) continue;
    const macAddress = normalizeMac(record.callingstationid) || normalizeMac(record.username);
    if (!macAddress || !wanted.has(macAddress)) continue;
    attempted += 1;
    try {
      const result = await disconnectSession({
        sessionId: record.acctsessionid,
        nasIp: record.nasipaddress,
        username: record.username,
        macAddress,
      });
      if (result.success) disconnected += 1;
    } catch (error) {
      logger.warn('Unable to disconnect session after RADIUS policy change', {
        macAddress,
        sessionId: record.acctsessionid,
        error: error.message,
      });
    }
  }
  return { attempted, disconnected };
}

let retryTimer = null;
function startRadiusSyncWorker() {
  if (retryTimer) return;
  retryTimer = setInterval(() => {
    void flushRadiusOutbox().catch((error) => logger.error('FreeRADIUS sync worker failed', error));
  }, 30 * 1000);
  void flushRadiusOutbox();
}

function stopRadiusSyncWorker() {
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = null;
}

module.exports = {
  queueUpsert,
  queueDelete,
  synchronizeMac,
  removeMacFromRadius,
  flushRadiusOutbox,
  applyPackageSnapshot,
  applyUserPackageSnapshot,
  revokeUserAuthorizations,
  revokePackageAuthorizations,
  queueExpiredAuthorizationRemoval,
  queueFullReconciliation,
  disconnectActiveAuthorizations,
  startRadiusSyncWorker,
  stopRadiusSyncWorker,
};
