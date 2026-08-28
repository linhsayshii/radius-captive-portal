const fs = require('fs');
const path = require('path');

const target = process.argv[2];
const outputDirectories = {
  portal: path.join(__dirname, '..', 'public', 'captive-portal', 'assets'),
  admin: path.join(__dirname, '..', 'public', 'admin', 'assets'),
};

const outputDirectory = outputDirectories[target];
if (!outputDirectory) {
  console.error('Usage: node scripts/clean-frontend-assets.js <portal|admin>');
  process.exit(1);
}

// Only generated hashed bundles live in these directories. Keep the stable
// HTML redirect aliases such as /admin/index.html intact while rebuilding.
fs.rmSync(outputDirectory, { recursive: true, force: true });
console.log(`Removed generated frontend assets: ${path.relative(process.cwd(), outputDirectory)}`);
