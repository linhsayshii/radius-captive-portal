const rateLimit = require('express-rate-limit');
const { loadConfig } = require('../config');
const logger = require('../utils/logger');

const config = loadConfig();

/**
 * Standard JSON rate limit error handler
 */
function createRateLimitHandler(customMessage) {
  return (req, res, next, options) => {
    logger.warn('Rate limit exceeded', {
      ip: req.ip,
      path: req.originalUrl,
      method: req.method,
    });

    const retryAfter = Math.ceil(options.windowMs / 1000);
    res.setHeader('Retry-After', retryAfter);
    res.status(options.statusCode).json({
      error: customMessage || 'Quá nhiều yêu cầu, vui lòng thử lại sau ít phút.',
      retryAfter,
    });
  };
}

/**
 * Auth Limiter: Protects login routes from brute force attacks
 * Typically 20 attempts per 15 minutes window
 */
const authLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitAuthMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: createRateLimitHandler('Quá nhiều lần thử đăng nhập. Vui lòng thử lại sau 15 phút.'),
});

/**
 * Guest Limiter: Protects captive portal guest connect & registration endpoints
 * Typically 60 attempts per 15 minutes window
 */
const guestLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitGuestMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: createRateLimitHandler('Quá nhiều yêu cầu kết nối WiFi. Vui lòng thử lại sau ít phút.'),
});

/**
 * API Limiter: General rate limiter for Admin and system APIs
 * Generous limit (1200 requests per 15 mins) that allows continuous dashboard polling
 * Skips rate limiting for authenticated admin sessions
 */
const apiLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitApiMax,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting if user is an authenticated admin
    if (req.session && req.session.adminId) {
      return true;
    }
    // Skip OPTIONS preflight requests
    if (req.method === 'OPTIONS') {
      return true;
    }
    return false;
  },
  handler: createRateLimitHandler('Quá nhiều yêu cầu đến máy chủ API. Vui lòng thử lại sau.'),
});

module.exports = {
  authLimiter,
  guestLimiter,
  apiLimiter,
};
