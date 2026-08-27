const express = require('express');
const { sessions, devices, users } = require('../../db');
const { requireApiAuth } = require('../../middleware/auth');

const router = express.Router();

router.get('/stats', requireApiAuth, (req, res) => {
  const totalUsers = users.getAll.all().length;
  const activeSessions = sessions.getActive.all().length;

  // Calculate today's data
  const today = new Date().toISOString().split('T')[0];
  const todaySessions = sessions.getActive.all().filter(s =>
    s.start_time && s.start_time.startsWith(today)
  );
  const todayData = todaySessions.reduce((sum, s) => sum + (s.quota_used_mb || 0), 0) * 1024 * 1024;

  // Bandwidth estimation
  const bandwidth = activeSessions > 0 ? activeSessions * 5 : 0; // Mbps

  res.json({
    users: totalUsers,
    activeSessions,
    todayData,
    bandwidth,
  });
});

module.exports = router;
