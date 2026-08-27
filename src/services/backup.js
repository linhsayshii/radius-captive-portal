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

  // Copy database
  fs.copyFileSync(config.databasePath, backupFile);

  // Upload to WebDAV if configured
  if (config.webdavUrl) {
    await uploadToWebDAV(backupFile, `wifi-portal-${timestamp}.db`);
  }

  // Clean old backups
  await cleanOldBackups(config.backupRetention || 10);

  return { success: true, file: backupFile };
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
