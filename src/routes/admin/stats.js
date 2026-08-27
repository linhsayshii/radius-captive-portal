const express = require('express');
const { sessions, devices, users, db } = require('../../db');
const { requireApiAuth } = require('../../middleware/auth');
const { getTotalLiveBandwidth } = require('../../services/sessionManager');

const router = express.Router();

router.get('/stats', requireApiAuth, (req, res) => {
  const totalUsers = users.getAll.all().length;
  const activeSessions = sessions.getActive.all().length;

  // Calculate today's total transferred data from all sessions today
  let todayData = 0;
  try {
    const todayRow = db.prepare(`
      SELECT SUM(COALESCE(quota_used_mb, 0)) as total_mb 
      FROM sessions 
      WHERE DATE(start_time) = DATE('now')
    `).get();
    todayData = (todayRow?.total_mb || 0) * 1024 * 1024;
  } catch (_) {
    const today = new Date().toISOString().split('T')[0];
    const todaySessions = sessions.getActive.all().filter(s =>
      s.start_time && s.start_time.startsWith(today)
    );
    todayData = todaySessions.reduce((sum, s) => sum + (s.quota_used_mb || 0), 0) * 1024 * 1024;
  }

  // Real-time live bandwidth calculation
  const live = getTotalLiveBandwidth();

  res.json({
    users: totalUsers,
    activeSessions,
    todayData,
    bandwidth: live.totalBandwidthMbps,
    bandwidthDown: live.totalDownMbps,
    bandwidthUp: live.totalUpMbps,
    bandwidthDownKbps: live.totalDownKbps,
    bandwidthUpKbps: live.totalUpKbps,
  });
});

module.exports = router;
