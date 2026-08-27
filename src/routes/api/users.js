const express = require('express');
const bcrypt = require('bcryptjs');
const { users, oauth } = require('../../db');
const { requireApiAuth } = require('../../middleware/auth');

const router = express.Router();

// List users
router.get('/', requireApiAuth, (req, res) => {
  const allUsers = users.getAll.all();
  res.json(allUsers);
});

// Create local user
router.post('/', requireApiAuth, async (req, res) => {
  const { username, password, email, max_devices, package_id } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const result = users.create.run({
    type: 'local',
    identifier: username,
    email: email || null,
    password_hash: passwordHash,
    display_name: username,
    max_devices: max_devices || 3,
    package_id: package_id ? parseInt(package_id) : null,
  });

  res.json({ id: result.lastInsertRowid, username });
});

// Update user
router.put('/:id', requireApiAuth, (req, res) => {
  const user = users.getById.get(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const { email, max_devices, is_active, package_id } = req.body;

  users.update.run({
    id: req.params.id,
    email: email !== undefined ? email : user.email,
    display_name: user.display_name,
    max_devices: max_devices !== undefined ? max_devices : user.max_devices,
    is_active: is_active !== undefined ? (is_active ? 1 : 0) : user.is_active,
    package_id: package_id !== undefined ? (package_id ? parseInt(package_id) : null) : user.package_id,
  });

  res.json({ success: true });
});

// Delete user
router.delete('/:id', requireApiAuth, (req, res) => {
  users.delete.run(req.params.id);
  res.json({ success: true });
});

// List OAuth addresses assigned to an account.
router.get('/:id/whitelist', requireApiAuth, (req, res) => {
  const user = users.getById.get(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json(oauth.getByUser.all(req.params.id));
});

// Add to OAuth whitelist
router.post('/:id/whitelist', requireApiAuth, (req, res) => {
  const { google_email } = req.body;

  if (!google_email) {
    return res.status(400).json({ error: 'Email required' });
  }

  try {
    oauth.create.run({
      user_id: req.params.id,
      google_email,
      allowed_by: req.session.adminId,
    });
    res.json({ success: true });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Email already whitelisted' });
    }
    throw err;
  }
});

// Remove from OAuth whitelist
router.delete('/:id/whitelist/:email', requireApiAuth, (req, res) => {
  const entry = oauth.getByEmail.get(req.params.email);
  if (entry && entry.user_id === parseInt(req.params.id)) {
    oauth.delete.run(entry.id);
  }
  res.json({ success: true });
});

module.exports = router;
