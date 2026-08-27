const bcrypt = require('bcryptjs');
const readline = require('readline');
const { admins, db } = require('../src/db');
const logger = require('../src/utils/logger');

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
  console.log('\n=== Create Admin Account ===\n');

  const username = await ask('Username: ');
  if (!username) {
    console.log('Username required');
    process.exit(1);
  }

  // Check if exists
  const existing = admins.getByUsername.get(username);
  if (existing) {
    console.log('Admin already exists:', username);
    process.exit(1);
  }

  const password = await ask('Password: ');
  if (!password || password.length < 8) {
    console.log('Password must be at least 8 characters');
    process.exit(1);
  }

  const confirm = await ask('Confirm password: ');
  if (password !== confirm) {
    console.log('Passwords do not match');
    process.exit(1);
  }

  rl.close();

  const passwordHash = await bcrypt.hash(password, 12);

  const result = admins.create.run({ username, password_hash: passwordHash });

  console.log('\nAdmin created successfully!');
  console.log('ID:', result.lastInsertRowid);
  console.log('Username:', username);
}

main().catch((err) => {
  logger.error('Error creating admin:', err);
  process.exit(1);
});
