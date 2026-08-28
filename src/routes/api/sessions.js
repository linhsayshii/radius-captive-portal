const express = require('express');
const { sessions, db } = require('../../db');
const { requireApiAuth } = require('../../middleware/auth');
const { terminateSession, getLiveMetrics } = require('../../services/sessionManager');
const { syncRadiusAccounting } = require('../../services/radiusAccountingSync');
const logger = require('../../utils/logger');

const router = express.Router();

router.get('/', requireApiAuth, async (req, res) => {
  try {
    const sync = await syncRadiusAccounting();
    res.set('X-Radius-Accounting-Sync', `${sync.synchronized}/${sync.records}`);
  } catch (error) {
    // Keep the dashboard usable with its last SQLite projection while making
    // a failed MariaDB accounting sync visible in server logs.
    logger.warn('Unable to refresh RADIUS accounting for sessions API', { error: error.message });
    res.set('X-Radius-Accounting-Sync', 'unavailable');
  }
  const activeSessions = sessions.getActive.all().map(s => {
    const live = s.session_id ? getLiveMetrics(s.session_id) : { rateDownKbps: 0, rateUpKbps: 0 };
    return {
      ...s,
      live_down_kbps: live.rateDownKbps,
      live_up_kbps: live.rateUpKbps,
      total_bytes_in: live.totalInputBytes || 0,
      total_bytes_out: live.totalOutputBytes || 0,
    };
  });
  res.json(activeSessions);
});

router.get('/history', requireApiAuth, (req, res) => {
  const { limit = 100 } = req.query;
  const history = db.prepare(`
    SELECT * FROM sessions ORDER BY start_time DESC LIMIT ?
  `).all(limit);
  res.json(history);
});

router.delete('/:id', requireApiAuth, async (req, res) => {
  const session = sessions.getById.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const result = await terminateSession(session, 'admin');
  if (!result.success) {
    return res.status(502).json({
      error: result.error || 'Router chưa xác nhận lệnh ngắt kết nối',
      disconnect: result.disconnect,
    });
  }

  res.json({ success: true, disconnect: result.disconnect });
});

module.exports = router;
