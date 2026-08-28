const mysql = require('mysql2/promise');
const { loadConfig } = require('../config');

let pool;

function getPool() {
  const { radiusDatabaseUrl } = loadConfig();
  if (!radiusDatabaseUrl) {
    throw new Error('RADIUS_DATABASE_URL is not configured');
  }
  if (!pool) {
    pool = mysql.createPool({ uri: radiusDatabaseUrl, connectionLimit: 5, enableKeepAlive: true });
  }
  return pool;
}

function reply(attribute, value, op = ':=') {
  return [attribute, String(value), op];
}

/**
 * Materialize portal authorization as conventional FreeRADIUS SQL records.
 * FreeRADIUS then owns Access-Accept/Reject and accounting; Node never binds
 * the RADIUS UDP ports.
 */
async function upsertAuthorization(entry) {
  const username = entry.mac_address;
  const expiresAt = new Date(entry.expires_at);
  const seconds = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  const replies = [reply('Session-Timeout', seconds), reply('Idle-Timeout', 300), reply('Acct-Interim-Interval', 60)];

  if (entry.bandwidth_up_kbps && entry.bandwidth_down_kbps) {
    replies.push(reply('Mikrotik-Rate-Limit', `${entry.bandwidth_up_kbps}k/${entry.bandwidth_down_kbps}k`));
  }
  if (entry.quota_mb) {
    replies.push(reply('Mikrotik-Total-Limit', Math.min(Number(entry.quota_mb) * 1024 * 1024, 4294967295)));
  }

  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('DELETE FROM radcheck WHERE username = ?', [username]);
    await connection.execute('DELETE FROM radreply WHERE username = ?', [username]);
    await connection.execute('DELETE FROM radius_authorizations WHERE mac_address = ?', [username]);
    await connection.execute(
      `INSERT INTO radius_authorizations
       (mac_address, expires_at, package_id, bandwidth_down_kbps, bandwidth_up_kbps, quota_mb, max_devices)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [username, expiresAt.toISOString().slice(0, 19).replace('T', ' '), entry.package_id || null, entry.bandwidth_down_kbps || null,
        entry.bandwidth_up_kbps || null, entry.quota_mb || null, entry.max_devices || null]
    );
    await connection.execute(
      'INSERT INTO radcheck (username, attribute, op, value) VALUES (?, ?, ?, ?)',
      [username, 'Cleartext-Password', ':=', username]
    );
    for (const [attribute, value, op] of replies) {
      await connection.execute(
        'INSERT INTO radreply (username, attribute, op, value) VALUES (?, ?, ?, ?)',
        [username, attribute, op, value]
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function removeAuthorization(macAddress) {
  const db = getPool();
  await Promise.all([
    db.execute('DELETE FROM radcheck WHERE username = ?', [macAddress]),
    db.execute('DELETE FROM radreply WHERE username = ?', [macAddress]),
    db.execute('DELETE FROM radius_authorizations WHERE mac_address = ?', [macAddress]),
  ]);
}

async function close() {
  if (pool) await pool.end();
  pool = undefined;
}

module.exports = { upsertAuthorization, removeAuthorization, close };
