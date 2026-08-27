const crypto = require('crypto');
const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { users, oauth, sessions } = require('../db');
const { loadConfig } = require('../config');
const { authorizeMac, normalizeMac, revokeMac, getAuthorizedMac } = require('./api/guest');
const { terminateSession } = require('../services/sessionManager');
const logger = require('../utils/logger');

const router = express.Router();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_GRACE_PERIOD_MS = 3 * 60 * 1000; // 3 minutes temporary access

async function revokeActiveSession(mac, reason) {
  try {
    const activeSession = sessions.getActiveByMac.get(mac, mac);
    if (activeSession) {
      await terminateSession(activeSession, reason);
    }
  } catch (err) {
    logger.error('Error disconnecting revoked OAuth session:', err);
  }
}

function isGoogleConfigured(config) {
  return Boolean(config.googleClientId && config.googleClientSecret && config.googleCallbackUrl);
}

function isSafeRouterUrl(value, requestHost) {
  if (!value || value.length > 1024) return false;

  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return false;

    const hostname = url.hostname.toLowerCase();
    const sameHost = hostname === requestHost.split(':')[0].toLowerCase();
    const isLocalHostname = hostname === 'localhost' || hostname.endsWith('.local');
    const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
    const octets = isIpv4 ? hostname.split('.').map(Number) : [];
    const isPrivateIpv4 = isIpv4 && octets.every((octet) => octet <= 255) && (
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    );

    return sameHost || isLocalHostname || isPrivateIpv4;
  } catch {
    return false;
  }
}

function createState(context, secret) {
  const encoded = Buffer.from(JSON.stringify({
    destination: context.destination || '',
    issuedAt: Date.now(),
    mac: context.mac || '',
    routerUrl: context.routerUrl || '',
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function readState(value, secret) {
  if (typeof value !== 'string') return null;
  const [encoded, signature, extra] = value.split('.');
  if (!encoded || !signature || extra) return null;

  const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  const suppliedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const state = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!Number.isFinite(state.issuedAt) || Date.now() - state.issuedAt > OAUTH_STATE_TTL_MS) return null;
    if (state.mac && !normalizeMac(state.mac)) return null;
    if (typeof state.routerUrl !== 'string' || typeof state.destination !== 'string') return null;
    return {
      destination: state.destination,
      mac: normalizeMac(state.mac) || '',
      routerUrl: state.routerUrl,
    };
  } catch {
    return null;
  }
}

function redirectToError(res, error) {
  return res.redirect(`/error.html?error=${encodeURIComponent(error)}`);
}

function redirectToSuccess(res, context) {
  const params = new URLSearchParams({ method: 'google' });
  if (context.mac) params.set('mac', context.mac);
  if (context.routerUrl) params.set('router_url', context.routerUrl);
  if (context.destination) params.set('dst', context.destination);
  return res.redirect(`/success.html?${params.toString()}`);
}

function configurePassport() {
  const config = loadConfig();
  if (!isGoogleConfigured(config)) return false;

  passport.use(new GoogleStrategy({
    clientID: config.googleClientId,
    clientSecret: config.googleClientSecret,
    callbackURL: config.googleCallbackUrl,
  }, async (_accessToken, _refreshToken, profile, done) => {
    try {
      const email = profile.emails?.[0]?.value?.trim().toLowerCase();
      if (!email) return done(null, false, { message: 'Google account does not expose an email address' });

      const whitelistEntry = oauth.getByEmail.get(email);
      if (!whitelistEntry) return done(null, false, { message: 'Email not whitelisted' });

      let user = users.getByEmail.get(email);
      if (!user) {
        const result = users.create.run({
          type: 'oauth',
          identifier: profile.id,
          email,
          password_hash: null,
          display_name: profile.displayName || email,
          max_devices: 3,
        });
        user = { id: result.lastInsertRowid };
      }

      return done(null, { id: user.id, email, type: 'oauth' });
    } catch (error) {
      return done(error);
    }
  }));

  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((user, done) => done(null, user));
  return true;
}

let passportConfigured = false;
function ensurePassportConfigured() {
  if (passportConfigured) return true;
  passportConfigured = configurePassport();
  return passportConfigured;
}

// POST /auth/google/prepare
// Pre-authorizes the client MAC with a 3-minute grace period to access Google OAuth
router.post('/google/prepare', (req, res) => {
  const config = loadConfig();
  if (!isGoogleConfigured(config) || !ensurePassportConfigured()) {
    return res.status(503).json({ error: 'oauth_not_configured' });
  }

  const rawMac = req.body.mac || req.query.mac;
  const mac = normalizeMac(rawMac);
  if (!mac) {
    return res.status(400).json({ error: 'invalid_mac' });
  }

  const candidateRouterUrl = typeof req.body.router_url === 'string' ? req.body.router_url : (req.query.router_url || '');
  const routerUrl = isSafeRouterUrl(candidateRouterUrl, req.get('host') || '') ? candidateRouterUrl : '';
  const destination = typeof req.body.dst === 'string' ? req.body.dst.slice(0, 1024) : (typeof req.query.dst === 'string' ? req.query.dst.slice(0, 1024) : '');

  // Grant temporary 3-minute grace period if device doesn't already have valid full access
  const existing = getAuthorizedMac(mac);
  let entry = existing;
  if (!existing || existing.access_type === 'oauth_grace') {
    entry = authorizeMac(mac, {
      access_type: 'oauth_grace',
      ip_address: req.ip,
      user_agent: req.headers['user-agent'],
    }, OAUTH_GRACE_PERIOD_MS);

    logger.info('Temporary OAuth grace period granted for MAC', {
      macAddress: mac,
      expiresAt: entry.expires_at,
      ip: req.ip,
    });
  }

  return res.json({
    success: true,
    mac,
    routerUrl,
    destination,
    expires_at: entry.expires_at,
    grace_period_seconds: 180,
  });
});

router.get('/google', (req, res, next) => {
  const config = loadConfig();
  if (!isGoogleConfigured(config) || !ensurePassportConfigured()) {
    return redirectToError(res, 'oauth_not_configured');
  }

  const mac = normalizeMac(req.query.mac) || '';
  const candidateRouterUrl = typeof req.query.router_url === 'string' ? req.query.router_url : '';
  const routerUrl = isSafeRouterUrl(candidateRouterUrl, req.get('host') || '') ? candidateRouterUrl : '';
  const destination = typeof req.query.dst === 'string' ? req.query.dst.slice(0, 1024) : '';

  // Ensure MAC has temporary grace period access while logging in
  if (mac) {
    const existing = getAuthorizedMac(mac);
    if (!existing || existing.access_type === 'oauth_grace') {
      authorizeMac(mac, {
        access_type: 'oauth_grace',
        ip_address: req.ip,
        user_agent: req.headers['user-agent'],
      }, OAUTH_GRACE_PERIOD_MS);

      logger.info('Temporary OAuth grace period activated on /auth/google', {
        macAddress: mac,
      });
    }
  }

  const state = createState({ destination, mac, routerUrl }, config.sessionSecret);

  return passport.authenticate('google', {
    prompt: 'select_account',
    scope: ['profile', 'email'],
    state,
  })(req, res, next);
});

router.get('/google/callback', (req, res, next) => {
  const config = loadConfig();
  if (!isGoogleConfigured(config) || !ensurePassportConfigured()) {
    return redirectToError(res, 'oauth_not_configured');
  }

  const context = readState(req.query.state, config.sessionSecret);
  if (!context) return redirectToError(res, 'invalid_oauth_state');

  return passport.authenticate('google', async (error, user, info) => {
    if (error) {
      if (context.mac) {
        revokeMac(context.mac);
        await revokeActiveSession(context.mac, 'oauth_error');
      }
      return next(error);
    }
    if (!user) {
      if (context.mac) {
        revokeMac(context.mac);
        await revokeActiveSession(context.mac, 'oauth_rejected');
      }
      return redirectToError(res, info?.message === 'Email not whitelisted' ? 'unauthorized' : 'oauth_failed');
    }

    req.logIn(user, (loginErr) => {
      if (loginErr) return next(loginErr);

      req.session.userId = user.id;
      req.session.userType = 'oauth';

      if (context.mac) {
        const authorization = authorizeMac(context.mac, {
          access_type: 'oauth',
          ip_address: req.ip,
          user_agent: req.headers['user-agent'],
          user_id: user.id,
          username: user.email,
        });
        logger.info('OAuth WiFi access granted & upgraded to full session', {
          email: user.email,
          expiresAt: authorization.expires_at,
          macAddress: context.mac,
        });
      }

      return req.session.save((saveError) => {
        if (saveError) return next(saveError);
        return redirectToSuccess(res, context);
      });
    });
  })(req, res, next);
});

module.exports = { router, passport, OAUTH_GRACE_PERIOD_MS };

