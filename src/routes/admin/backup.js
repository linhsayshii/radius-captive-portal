const express = require('express');
const { requireApiAuth } = require('../../middleware/auth');
const { createBackup } = require('../../services/backup');

const router = express.Router();

router.post('/backup', requireApiAuth, async (req, res) => {
  try {
    const result = await createBackup();
    res.json({ success: true, message: `Backup created: ${result.file}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
