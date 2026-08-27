const { execSync } = require('child_process');

/**
 * Attempt to resolve MAC address from client IP using local system ARP table
 * @param {string} ip - IP address of the client
 * @returns {string|null} - MAC address if found, or null
 */
function getMacFromIp(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1') return null;
  const cleanIp = ip.replace(/^.*:/, '').trim();

  try {
    // Try macOS / Linux arp command
    const output = execSync(`arp -n ${cleanIp} 2>/dev/null || arp -an 2>/dev/null`, {
      timeout: 1000,
      encoding: 'utf8',
    });

    const lines = output.split('\n');
    for (const line of lines) {
      if (line.includes(cleanIp)) {
        const match = line.match(/([0-9a-fA-F]{1,2}[:\-][0-9a-fA-F]{1,2}[:\-][0-9a-fA-F]{1,2}[:\-][0-9a-fA-F]{1,2}[:\-][0-9a-fA-F]{1,2}[:\-][0-9a-fA-F]{1,2})/);
        if (match && match[1] && !match[1].startsWith('ff:ff')) {
          return match[1];
        }
      }
    }
  } catch (_) {}

  return null;
}

module.exports = { getMacFromIp };
