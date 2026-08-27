const express = require('express');
const { sessions, db } = require('../../db');
const { requireApiAuth } = require('../../middleware/auth');
const { terminateSession } = require('../../services/sessionManager');

const router = express.Router();

router.get('/', requireApiAuth, (req, res) => {
  const activeSessions = sessions.getActive.all();
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

  await terminateSession(session, 'admin');
  res.json({ success: true });
});

module.exports = router;
