const app = require('./app');
const { loadConfig } = require('./config');
const logger = require('./utils/logger');
const { start: startRadius } = require('./services/radiusServer');

const config = loadConfig();

app.listen(config.port, () => {
  logger.info(`WiFi Portal server started on port ${config.port}`);
  logger.info(`Environment: ${config.nodeEnv}`);
  logger.info(`Database: ${config.databasePath}`);
});

// Authentication requests arrive on 1812 by default. 3799 is reserved for CoA.
startRadius({ authPort: config.radiusAuthPort, accountingPort: config.radiusAccountingPort });
