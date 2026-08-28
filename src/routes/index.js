const express = require('express');
const router = express.Router();
const { loadConfig } = require('../config');

const config = loadConfig();

// RFC 8910 endpoint advertised by DHCP Option 114.
router.get('/.well-known/captive-portal', (req, res) => {
  res
    .type('application/captive+json')
    .set('Cache-Control', 'no-store')
    .json({
      captive: true,
      'user-portal-url': config.captivePortalUserUrl,
    });
});

router.get('/', (req, res) => {
  res.sendFile('index.html', { root: 'public/captive-portal' });
});

module.exports = router;
