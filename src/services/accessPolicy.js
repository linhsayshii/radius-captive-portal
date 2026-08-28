const { packages } = require('../db');

const DEFAULT_MAX_DEVICES = 3;
// A MAC authorization must have an expiry for RADIUS SQL lookups. Accounts
// without a package do not receive a Session-Timeout, so this is only the
// authorization renewal horizon, not a per-login usage limit.
const UNLIMITED_ACCOUNT_AUTHORIZATION_SECONDS = 365 * 24 * 60 * 60;

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

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
  const manualDownKbps = positiveInteger(user?.bandwidth_down_kbps);
  const manualUpKbps = positiveInteger(user?.bandwidth_up_kbps);
  const manualDurationMinutes = positiveInteger(user?.duration_minutes);
  const hasManualRateLimit = Boolean(manualDownKbps && manualUpKbps);
  const manualDurationSeconds = manualDurationMinutes ? manualDurationMinutes * 60 : null;

  return {
    package: pkg,
    packageId,
    packageValid: !packageId || Boolean(pkg?.is_active),
    durationSeconds: pkg?.duration_minutes
      ? Math.max(1, Number(pkg.duration_minutes) * 60)
      : manualDurationSeconds,
    authorizationDurationSeconds: pkg?.duration_minutes
      ? Math.max(1, Number(pkg.duration_minutes) * 60)
      : manualDurationSeconds || UNLIMITED_ACCOUNT_AUTHORIZATION_SECONDS,
    quotaTotalMb: pkg?.quota_mb ? Number(pkg.quota_mb) : null,
    downKbps: pkg?.bandwidth_down_kbps || (hasManualRateLimit ? manualDownKbps : null),
    upKbps: pkg?.bandwidth_up_kbps || (hasManualRateLimit ? manualUpKbps : null),
    maxDevices: pkg?.max_devices || positiveInteger(user?.max_devices) || DEFAULT_MAX_DEVICES,
  };
}

function getAuthorizationDurationMs(user) {
  return getAccessPolicy(user).authorizationDurationSeconds * 1000;
}

module.exports = {
  UNLIMITED_ACCOUNT_AUTHORIZATION_SECONDS,
  getAccessPolicy,
  getAuthorizationDurationMs,
};
