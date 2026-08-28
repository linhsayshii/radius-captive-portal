const app = require('./app');
const { loadConfig } = require('./config');
const logger = require('./utils/logger');
const { startRadiusSyncWorker, stopRadiusSyncWorker } = require('./services/radiusSync');
const { startRadiusAccountingSync, stopRadiusAccountingSync } = require('./services/radiusAccountingSync');
const { startIdleChecker, stopIdleChecker } = require('./services/sessionManager');

const config = loadConfig();

function validateRuntimeConfig() {
  const errors = [];
  const ports = [config.port];
  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    errors.push('One or more configured ports are invalid');
  }

  if (config.nodeEnv === 'production') {
    if (!config.radiusSharedSecret || config.radiusSharedSecret === 'changeme') {
      errors.push('RADIUS_SHARED_SECRET must be configured in production');
    }
    if (!config.sessionSecret || config.sessionSecret === 'dev-secret-change-in-production') {
      errors.push('ADMIN_SESSION_SECRET must be configured in production');
    }
    if (!config.radiusClients.length) {
      errors.push('RADIUS_CLIENTS must contain the trusted NAS/router source IPs in production');
    }
    if (!config.radiusDatabaseUrl) {
      errors.push('RADIUS_DATABASE_URL must point to the FreeRADIUS MariaDB policy store in production');
    }
  }

  return errors;
}

function startHttpServer() {
  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, () => {
      server.off('error', onError);
      logger.info(`WiFi Portal server started on port ${config.port}`);
      logger.info(`Environment: ${config.nodeEnv}`);
      logger.info(`Database: ${config.databasePath}`);
      resolve(server);
    });
    const onError = (error) => reject(error);
    server.once('error', onError);
  });
}

async function bootstrap() {
  const configurationErrors = validateRuntimeConfig();
  if (configurationErrors.length) {
    throw new Error(`Invalid runtime configuration: ${configurationErrors.join('; ')}`);
  }

  const httpServer = await startHttpServer();
  startRadiusSyncWorker();
  startRadiusAccountingSync();
  startIdleChecker();

  const shutdown = (signal) => {
    logger.info(`Received ${signal}; shutting down WiFi Portal`);
    stopRadiusSyncWorker();
    stopRadiusAccountingSync();
    stopIdleChecker();
    httpServer.close(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((error) => {
  logger.error('WiFi Portal failed to start:', error);
  process.exitCode = 1;
});
