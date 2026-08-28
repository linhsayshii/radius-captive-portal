const mysql = require('mysql2/promise');
const { loadConfig } = require('../config');

let pool;
let accountingSchemaReady;

function getPool() {
  const { radiusDatabaseUrl } = loadConfig();
  if (!radiusDatabaseUrl) {
    throw new Error('RADIUS_DATABASE_URL is not configured');
  }
  if (!pool) {
    // mysql2 accepts a connection URI as the createPool argument. Passing it
    // under an arbitrary `uri` property does not configure the host/user/db;
    // inside Docker that makes the portal try its own container instead of
    // radius-db, so Accounting rows are never read.
    pool = mysql.createPool(radiusDatabaseUrl);
  }
  return pool;
}

async function ensureAccountingSchema() {
  if (!accountingSchemaReady) {
    accountingSchemaReady = Promise.all([
      'nasport VARCHAR(32) NOT NULL DEFAULT \'\'',
      'nasportid VARCHAR(255) NOT NULL DEFAULT \'\'',
      'nasporttype VARCHAR(64) NOT NULL DEFAULT \'\'',
      'framedipaddress VARCHAR(45) NOT NULL DEFAULT \'\'',
      'calledstationid VARCHAR(255) NOT NULL DEFAULT \'\'',
    ].map((definition) => getPool().query(`ALTER TABLE radacct ADD COLUMN IF NOT EXISTS ${definition}`)))
      .catch((error) => {
        accountingSchemaReady = undefined;
        throw error;
      });
  }
  await accountingSchemaReady;
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
  const { radiusInterimIntervalSeconds } = loadConfig();
  const replies = [reply('Session-Timeout', seconds), reply('Idle-Timeout', 300), reply('Acct-Interim-Interval', radiusInterimIntervalSeconds)];

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
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('DELETE FROM radcheck WHERE username = ?', [macAddress]);
    await connection.execute('DELETE FROM radreply WHERE username = ?', [macAddress]);
    await connection.execute('DELETE FROM radius_authorizations WHERE mac_address = ?', [macAddress]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function getRecentAccounting() {
  await ensureAccountingSchema();
  const db = getPool();
  const [rows] = await db.execute(`
    SELECT acctsessionid, username, nasipaddress, nasport, nasportid, nasporttype,
      framedipaddress, callingstationid, calledstationid,
      acctstarttime, acctstoptime, acctsessiontime, acctinputoctets, acctoutputoctets
    FROM radacct
    WHERE acctstoptime IS NULL
       OR acctstoptime >= UTC_TIMESTAMP() - INTERVAL 2 DAY
    ORDER BY acctstarttime DESC
  `);
  return rows;
}

async function close() {
  if (pool) await pool.end();
  pool = undefined;
  accountingSchemaReady = undefined;
}

module.exports = { upsertAuthorization, removeAuthorization, getRecentAccounting, ensureAccountingSchema, close };
