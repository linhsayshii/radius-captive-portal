const crypto = require('crypto');
const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { users, oauth, logs } = require('../db');
const { loadConfig } = require('../config');
const { authorizeMac, normalizeMac } = require('./api/guest');
const logger = require('../utils/logger');
const { getAccessPolicy, getAuthorizationDurationMs } = require('../services/accessPolicy');

const router = express.Router();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

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

      let user = whitelistEntry.user_id ? users.getById.get(whitelistEntry.user_id) : users.getByEmail.get(email);
      if (user && !user.is_active) {
        return done(null, false, { message: 'Account is disabled' });
      }
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

      const fullUser = users.getById.get(user.id);
      if (!getAccessPolicy(fullUser).packageValid) {
        return done(null, false, { message: 'Assigned package is inactive' });
      }

      return done(null, { id: fullUser.id, email, type: fullUser.type });
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

router.get('/google', (req, res, next) => {
  const config = loadConfig();
  if (!isGoogleConfigured(config) || !ensurePassportConfigured()) {
    return redirectToError(res, 'oauth_not_configured');
  }

  const mac = normalizeMac(req.query.mac) || '';
  const candidateRouterUrl = typeof req.query.router_url === 'string' ? req.query.router_url : '';
  const routerUrl = isSafeRouterUrl(candidateRouterUrl, req.get('host') || '') ? candidateRouterUrl : '';
  const destination = typeof req.query.dst === 'string' ? req.query.dst.slice(0, 1024) : '';
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

  return passport.authenticate('google', { failureRedirect: '/error.html?error=unauthorized' })(req, res, (error) => {
    if (error) return next(error);
    if (!req.user) return redirectToError(res, 'oauth_failed');

    req.session.userId = req.user.id;
    req.session.userType = 'oauth';

    if (context.mac) {
      const authorization = authorizeMac(context.mac, {
        access_type: 'oauth',
        ip_address: req.ip,
        user_agent: req.headers['user-agent'],
        user_id: req.user.id,
        username: req.user.email,
      }, getAuthorizationDurationMs(users.getById.get(req.user.id)));

      // Log successful connection
      try {
        logs.create.run({
          user_id: req.user.id,
          session_id: context.mac,
          mac_address: context.mac,
          ip_address: req.ip,
          action: 'oauth_connect',
          nas_identifier: null,
          details: JSON.stringify({
            email: req.user.email,
            user_agent: req.headers['user-agent'],
          }),
        });
      } catch (logErr) {
        logger.error('Error recording OAuth connection log:', logErr);
      }

      logger.info('OAuth WiFi access granted', {
        email: req.user.email,
        expiresAt: authorization.expires_at,
        macAddress: context.mac,
      });
    }

    return req.session.save((saveError) => {
      if (saveError) return next(saveError);
      return redirectToSuccess(res, context);
    });
  });
});

module.exports = { router, passport };

