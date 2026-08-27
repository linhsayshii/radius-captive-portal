const { packages, settings } = require('../src/db');
const logger = require('../src/utils/logger');

// Sample packages
const samplePackages = [
  {
    name: '15 phút',
    duration_minutes: 15,
    quota_mb: 100,
    bandwidth_down_kbps: 5000,
    bandwidth_up_kbps: 2000,
    max_devices: 1,
  },
  {
    name: '1 giờ',
    duration_minutes: 60,
    quota_mb: 500,
    bandwidth_down_kbps: 5000,
    bandwidth_up_kbps: 2000,
    max_devices: 2,
  },
  {
    name: '4 giờ',
    duration_minutes: 240,
    quota_mb: 2000,
    bandwidth_down_kbps: 10000,
    bandwidth_up_kbps: 5000,
    max_devices: 3,
  },
  {
    name: 'Ngày (8 giờ)',
    duration_minutes: 480,
    quota_mb: null, // Unlimited
    bandwidth_down_kbps: 10000,
    bandwidth_up_kbps: 5000,
    max_devices: 5,
  },
];

async function main() {
  console.log('\n=== Setup Sample Data ===\n');

  // Check if packages exist
  const existing = packages.getActive.all();
  if (existing.length > 0) {
    console.log('Packages already exist. Skipping...');
    process.exit(0);
  }

  for (const pkg of samplePackages) {
    const result = packages.create.run({
      ...pkg,
      created_by: 1, // Assuming admin exists
    });
    console.log(`Created package: ${pkg.name} (ID: ${result.lastInsertRowid})`);
  }

  console.log('\nSample packages created successfully!');
}

main().catch((err) => {
  logger.error('Error setting up sample data:', err);
  process.exit(1);
});
