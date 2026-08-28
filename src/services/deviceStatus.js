const { db } = require('../db');

// The devices table is a registry and may still point at an old session after
// a reconnect. The RADIUS accounting projection in sessions is the source of
// truth for whether a MAC is online right now.
const listDevicesWithLiveStatus = db.prepare(`
  SELECT
    d.id,
    d.user_id,
    d.mac_address,
    d.device_name,
    d.session_id,
    d.first_seen,
    COALESCE(
      (
        SELECT s.username
        FROM sessions s
        WHERE s.mac_address = d.mac_address AND s.is_active = 1
        ORDER BY julianday(s.last_activity) DESC, s.id DESC
        LIMIT 1
      ),
      linked_session.username
    ) AS username,
    CASE WHEN EXISTS (
      SELECT 1
      FROM sessions s
      WHERE s.mac_address = d.mac_address AND s.is_active = 1
    ) THEN 1 ELSE 0 END AS is_online,
    COALESCE(
      (
        SELECT s.last_activity
        FROM sessions s
        WHERE s.mac_address = d.mac_address AND s.is_active = 1
        ORDER BY julianday(s.last_activity) DESC, s.id DESC
        LIMIT 1
      ),
      d.last_seen
    ) AS last_seen
  FROM devices d
  LEFT JOIN sessions linked_session ON linked_session.id = d.session_id
  ORDER BY julianday(last_seen) DESC, d.id DESC
`);

function getDevicesWithLiveStatus() {
  return listDevicesWithLiveStatus.all();
}

module.exports = { getDevicesWithLiveStatus };
