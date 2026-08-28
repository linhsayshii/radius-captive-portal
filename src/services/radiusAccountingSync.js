const { db, sessions, devices, macAuthorizations } = require('../db');
const { getRecentAccounting } = require('./radiusPolicyStore');
const { updateSessionActivity, handleNewConnection } = require('./sessionManager');
const logger = require('../utils/logger');

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
  INSERT INTO sessions (user_id, package_id, mac_address, ip_address, nas_identifier,
    username, session_id, quota_total_mb, quota_used_mb, bandwidth_down_kbps,
    bandwidth_up_kbps, is_active, start_time, last_activity, end_time, terminated_by)
  VALUES (@user_id, @package_id, @mac_address, @ip_address, @nas_identifier,
    @username, @session_id, @quota_total_mb, @quota_used_mb, @bandwidth_down_kbps,
    @bandwidth_up_kbps, @is_active, @start_time, @last_activity, @end_time, @terminated_by)
  ON CONFLICT(session_id) DO UPDATE SET
    user_id = excluded.user_id, package_id = excluded.package_id, mac_address = excluded.mac_address,
    nas_identifier = excluded.nas_identifier, username = excluded.username,
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

async function syncRadiusAccounting() {
  const records = await getRecentAccounting();
  let synchronized = 0;

  const transaction = db.transaction((rows) => {
    for (const record of rows) {
      const macAddress = normalizeMac(record.callingstationid) || normalizeMac(record.username);
      if (!macAddress || !record.acctsessionid) continue;

      const authorization = macAuthorizations.get.get(macAddress);
      const isActive = record.acctstoptime ? 0 : 1;
      const quotaBytes = Number(record.acctinputoctets || 0) + Number(record.acctoutputoctets || 0);
      upsertSessionFromRadius.run({
        user_id: authorization?.user_id || null,
        package_id: authorization?.package_id || null,
        mac_address: macAddress,
        ip_address: null,
        nas_identifier: record.nasipaddress || null,
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
  return { records: records.length, synchronized };
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

module.exports = { normalizeMac, syncRadiusAccounting, startRadiusAccountingSync, stopRadiusAccountingSync };
