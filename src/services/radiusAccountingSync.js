const { db, sessions, devices, macAuthorizations } = require('../db');
const { getRecentAccounting } = require('./radiusPolicyStore');
const { updateSessionActivity, handleNewConnection } = require('./sessionManager');
const logger = require('../utils/logger');

const accountingStatus = {
  state: 'idle',
  lastAttemptAt: null,
  lastSuccessAt: null,
  records: 0,
  synchronized: 0,
  skipped: 0,
  error: null,
};

function normalizeMac(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[^0-9a-f]/gi, '').toLowerCase();
  return normalized.length === 12 ? normalized : null;
}

function toSqliteDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(`${value}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const upsertSessionFromRadius = db.prepare(`
  INSERT INTO sessions (user_id, package_id, mac_address, ip_address, nas_identifier, nas_port,
    nas_port_type, nas_port_id, called_station_id,
    username, session_id, quota_total_mb, quota_used_mb, bandwidth_down_kbps,
    bandwidth_up_kbps, is_active, start_time, last_activity, end_time, terminated_by)
  VALUES (@user_id, @package_id, @mac_address, @ip_address, @nas_identifier, @nas_port,
    @nas_port_type, @nas_port_id, @called_station_id,
    @username, @session_id, @quota_total_mb, @quota_used_mb, @bandwidth_down_kbps,
    @bandwidth_up_kbps, @is_active, @start_time, @last_activity, @end_time, @terminated_by)
  ON CONFLICT(session_id) DO UPDATE SET
    user_id = excluded.user_id, package_id = excluded.package_id, mac_address = excluded.mac_address,
    nas_identifier = excluded.nas_identifier, nas_port = excluded.nas_port,
    nas_port_type = excluded.nas_port_type, nas_port_id = excluded.nas_port_id,
    called_station_id = excluded.called_station_id, ip_address = excluded.ip_address,
    username = excluded.username,
    quota_total_mb = excluded.quota_total_mb, quota_used_mb = excluded.quota_used_mb,
    bandwidth_down_kbps = excluded.bandwidth_down_kbps, bandwidth_up_kbps = excluded.bandwidth_up_kbps,
    is_active = excluded.is_active, last_activity = excluded.last_activity,
    end_time = excluded.end_time, terminated_by = excluded.terminated_by
`);

const upsertDeviceFromRadius = db.prepare(`
  INSERT INTO devices (user_id, mac_address, device_name, session_id, is_online, last_seen)
  VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(mac_address) DO UPDATE SET
    user_id = COALESCE(excluded.user_id, devices.user_id), session_id = excluded.session_id,
    is_online = excluded.is_online, last_seen = CURRENT_TIMESTAMP
`);

async function performRadiusAccountingSync() {
  accountingStatus.state = 'syncing';
  accountingStatus.lastAttemptAt = new Date().toISOString();

  try {
    const records = await getRecentAccounting();
    let synchronized = 0;
    let skipped = 0;

    const transaction = db.transaction((rows) => {
      for (const record of rows) {
        const macAddress = normalizeMac(record.callingstationid) || normalizeMac(record.username);
        if (!macAddress || !record.acctsessionid) {
          skipped += 1;
          continue;
        }

        const authorization = macAuthorizations.get.get(macAddress);
        const isActive = record.acctstoptime ? 0 : 1;
        const quotaBytes = Number(record.acctinputoctets || 0) + Number(record.acctoutputoctets || 0);
        upsertSessionFromRadius.run({
          user_id: authorization?.user_id || null,
          package_id: authorization?.package_id || null,
          mac_address: macAddress,
          ip_address: record.framedipaddress || null,
          nas_identifier: record.nasipaddress || null,
          nas_port: record.nasport || null,
          nas_port_type: record.nasporttype || null,
          nas_port_id: record.nasportid || null,
          called_station_id: record.calledstationid || null,
          username: record.username || macAddress,
          session_id: record.acctsessionid,
          quota_total_mb: authorization?.quota_mb || null,
          quota_used_mb: Math.floor(quotaBytes / (1024 * 1024)),
          bandwidth_down_kbps: authorization?.bandwidth_down_kbps || null,
          bandwidth_up_kbps: authorization?.bandwidth_up_kbps || null,
          is_active: isActive,
          start_time: toSqliteDate(record.acctstarttime) || new Date().toISOString(),
          last_activity: toSqliteDate(record.acctstoptime) || new Date().toISOString(),
          end_time: toSqliteDate(record.acctstoptime),
          terminated_by: record.acctstoptime ? 'radius_accounting_stop' : null,
        });
        const session = sessions.getBySessionId.get(record.acctsessionid);
        if (session) {
          upsertDeviceFromRadius.run(authorization?.user_id || null, macAddress, null, session.id, isActive);
        }
        synchronized += 1;
      }
    });
    transaction(records);

    // Feed the existing dashboard rate calculator with each NAS interim update.
    for (const record of records) {
      if (record.acctsessionid && !record.acctstoptime) {
        updateSessionActivity(record.acctsessionid, Number(record.acctinputoctets || 0), Number(record.acctoutputoctets || 0));
        const macAddress = normalizeMac(record.callingstationid) || normalizeMac(record.username);
        const authorization = macAddress ? macAuthorizations.get.get(macAddress) : null;
        if (authorization?.user_id) {
          await handleNewConnection(authorization.user_id, macAddress, record.nasipaddress);
        }
      }
    }
    const result = { records: records.length, synchronized, skipped };
    Object.assign(accountingStatus, {
      state: 'ok',
      lastSuccessAt: new Date().toISOString(),
      records: result.records,
      synchronized: result.synchronized,
      skipped: result.skipped,
      error: null,
    });
    return result;
  } catch (error) {
    Object.assign(accountingStatus, {
      state: 'error',
      error: error.message || String(error),
    });
    throw error;
  }
}

let syncInFlight = null;
function syncRadiusAccounting() {
  if (syncInFlight) return syncInFlight;
  syncInFlight = performRadiusAccountingSync().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

let accountingTimer = null;
function startRadiusAccountingSync() {
  if (accountingTimer) return;
  accountingTimer = setInterval(() => {
    void syncRadiusAccounting().catch((error) => logger.error('RADIUS accounting synchronization failed', error));
  }, 30 * 1000);
  void syncRadiusAccounting().catch((error) => logger.warn('Initial RADIUS accounting synchronization failed', { error: error.message }));
}

function stopRadiusAccountingSync() {
  if (accountingTimer) clearInterval(accountingTimer);
  accountingTimer = null;
}

function getRadiusAccountingStatus() {
  return { ...accountingStatus };
}

module.exports = { normalizeMac, syncRadiusAccounting, startRadiusAccountingSync, stopRadiusAccountingSync, getRadiusAccountingStatus };
