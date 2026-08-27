const express = require('express');
const router = express.Router();
const statsRouter = require('./admin/stats');

router.get('/', (req, res) => {
  res.send('Admin API');
});

router.use(statsRouter);

module.exports = router;
