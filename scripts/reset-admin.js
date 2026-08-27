/**
 * Reset admin password
 * Usage: node scripts/reset-admin.js
 */

const bcrypt = require('bcryptjs');
const readline = require('readline');
const { admins } = require('../src/db');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

async function main() {
  console.log('\n=== Reset Admin Password ===\n');

  const username = await ask('Username [admin]: ') || 'admin';
  const password = await ask('New password: ');

  if (!password || password.length < 8) {
    console.log('Password must be at least 8 characters');
    rl.close();
    process.exit(1);
  }

  rl.close();

  // Hash password
  const passwordHash = await bcrypt.hash(password, 12);

  // Check if admin exists
  const existing = admins.getByUsername.get(username);

  if (existing) {
    // Update existing
    const db = require('../src/db').db;
    db.prepare('UPDATE admins SET password_hash = ? WHERE username = ?').run(passwordHash, username);
    console.log(`\n✅ Password updated for: ${username}`);
  } else {
    // Create new
    admins.create.run({ username, password_hash: passwordHash });
    console.log(`\n✅ Admin created: ${username}`);
  }

  console.log(`\nNew password: ${password}`);
  console.log('(Make sure to remember this password!)\n');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
