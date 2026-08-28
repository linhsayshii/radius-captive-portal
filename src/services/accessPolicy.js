const { packages } = require('../db');

const DEFAULT_DURATION_SECONDS = 24 * 60 * 60;
const DEFAULT_DOWN_KBPS = 5000;
const DEFAULT_UP_KBPS = 2000;
const DEFAULT_MAX_DEVICES = 3;

/**
 * Resolve the policy applied to a user at the point a network session starts.
 * Keeping this in one place prevents the portal, RADIUS Access and Accounting
 * flows from applying different package values.
 */
function getAccessPolicy(user) {
  const packageId = Number.isInteger(Number(user?.package_id)) && Number(user.package_id) > 0
    ? Number(user.package_id)
    : null;
  const pkg = packageId ? packages.getById.get(packageId) : null;

  return {
    package: pkg,
    packageId,
    packageValid: !packageId || Boolean(pkg?.is_active),
    durationSeconds: pkg?.duration_minutes
      ? Math.max(1, Number(pkg.duration_minutes) * 60)
      : DEFAULT_DURATION_SECONDS,
    quotaTotalMb: pkg?.quota_mb ? Number(pkg.quota_mb) : null,
    downKbps: pkg?.bandwidth_down_kbps || DEFAULT_DOWN_KBPS,
    upKbps: pkg?.bandwidth_up_kbps || DEFAULT_UP_KBPS,
    maxDevices: pkg?.max_devices || user?.max_devices || DEFAULT_MAX_DEVICES,
  };
}

function getAuthorizationDurationMs(user) {
  return getAccessPolicy(user).durationSeconds * 1000;
}

module.exports = {
  DEFAULT_DURATION_SECONDS,
  getAccessPolicy,
  getAuthorizationDurationMs,
};
