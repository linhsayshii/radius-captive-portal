const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadConfig } = require('../config');
const { db } = require('../db');

async function createBackup() {
  const config = loadConfig();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.dirname(config.databasePath);
  const backupFile = path.join(backupDir, `backup-${timestamp}.db`);

  try {
    // SQLite WAL databases cannot be safely backed up with a plain file copy.
    // better-sqlite3's backup API creates a consistent snapshot.
    await db.backup(backupFile);

    if (config.webdavUrl) {
      await uploadToWebDAV(backupFile, `wifi-portal-${timestamp}.db`);
    }

    const sizeBytes = fs.statSync(backupFile).size;
    db.prepare(`
      INSERT INTO backups (filename, size_bytes, status)
      VALUES (?, ?, ?)
    `).run(path.basename(backupFile), sizeBytes, config.webdavUrl ? 'uploaded' : 'local');

    await cleanOldBackups(config.backupRetention || 10);
    return { success: true, file: backupFile, sizeBytes };
  } catch (error) {
    db.prepare(`
      INSERT INTO backups (filename, status)
      VALUES (?, ?)
    `).run(path.basename(backupFile), 'failed');
    throw error;
  }
}

async function uploadToWebDAV(filePath, fileName) {
  const config = loadConfig();
  const url = new URL(`${config.webdavUrl}/${fileName}`);

  const response = await fetch(url.toString(), {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Authorization': `Basic ${Buffer.from(
        `${config.webdavUsername}:${config.webdavPassword}`
      ).toString('base64')}`,
    },
    body: fs.createReadStream(filePath),
  });

  if (!response.ok) {
    throw new Error(`WebDAV upload failed: ${response.status}`);
  }
}

async function cleanOldBackups(retention) {
  const config = loadConfig();
  const backupDir = path.dirname(config.databasePath);
  const files = fs.readdirSync(backupDir)
    .filter(f => f.startsWith('backup-') && f.endsWith('.db'))
    .map(f => ({
      name: f,
      path: path.join(backupDir, f),
      time: fs.statSync(path.join(backupDir, f)).mtime,
    }))
    .sort((a, b) => b.time - a.time);

  // Keep only retention number of backups
  for (let i = retention; i < files.length; i++) {
    fs.unlinkSync(files[i].path);
  }
}

module.exports = { createBackup, uploadToWebDAV, cleanOldBackups };
