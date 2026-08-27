const express = require('express');
const router = express.Router();
const { requireApiAuth } = require('../../middleware/auth');

// Health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

module.exports = router;
