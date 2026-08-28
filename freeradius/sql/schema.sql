CREATE TABLE IF NOT EXISTS radcheck (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  attribute VARCHAR(64) NOT NULL,
  op CHAR(2) NOT NULL DEFAULT ':=',
  value VARCHAR(253) NOT NULL,
  INDEX username_idx (username)
);

CREATE TABLE IF NOT EXISTS radreply (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  attribute VARCHAR(64) NOT NULL,
  op CHAR(2) NOT NULL DEFAULT ':=',
  value VARCHAR(253) NOT NULL,
  INDEX username_idx (username)
);

CREATE TABLE IF NOT EXISTS radacct (
  radacctid BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  acctsessionid VARCHAR(64) NOT NULL,
  username VARCHAR(64) NOT NULL,
  nasipaddress VARCHAR(45) NOT NULL DEFAULT '',
  nasport VARCHAR(32) NOT NULL DEFAULT '',
  nasportid VARCHAR(255) NOT NULL DEFAULT '',
  nasporttype VARCHAR(64) NOT NULL DEFAULT '',
  framedipaddress VARCHAR(45) NOT NULL DEFAULT '',
  callingstationid VARCHAR(64) NOT NULL DEFAULT '',
  calledstationid VARCHAR(255) NOT NULL DEFAULT '',
  acctstarttime DATETIME NULL,
  acctstoptime DATETIME NULL,
  acctsessiontime BIGINT UNSIGNED NOT NULL DEFAULT 0,
  acctinputoctets BIGINT UNSIGNED NOT NULL DEFAULT 0,
  acctoutputoctets BIGINT UNSIGNED NOT NULL DEFAULT 0,
  UNIQUE KEY acctsessionid_unique (acctsessionid),
  INDEX username_idx (username)
);

CREATE TABLE IF NOT EXISTS radius_authorizations (
  mac_address VARCHAR(32) PRIMARY KEY,
  expires_at DATETIME NOT NULL,
  package_id BIGINT NULL,
  bandwidth_down_kbps INT NULL,
  bandwidth_up_kbps INT NULL,
  quota_mb BIGINT NULL,
  max_devices INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX expires_at_idx (expires_at)
);
