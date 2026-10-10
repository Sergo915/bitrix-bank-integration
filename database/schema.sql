-- Milon / Ameria application database schema
-- Compatible with MySQL 8.4.x (local and server)

CREATE DATABASE IF NOT EXISTS milon_ameria
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

USE milon_ameria;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  portal_domain VARCHAR(191) NOT NULL,
  bitrix_user_id BIGINT UNSIGNED NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  first_name VARCHAR(100) NULL,
  last_name VARCHAR(100) NULL,
  email VARCHAR(255) NULL,
  app_role VARCHAR(32) NOT NULL DEFAULT 'user',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_portal_bitrix (portal_domain, bitrix_user_id),
  KEY idx_users_role_active (app_role, is_active)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS user_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  session_token_hash BINARY(32) NOT NULL,
  opened_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  ended_at DATETIME(3) NULL,
  end_reason VARCHAR(32) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sessions_token_hash (session_token_hash),
  KEY idx_sessions_user_opened (user_id, opened_at),
  KEY idx_sessions_active (ended_at, expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sync_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  operation_id CHAR(36) NOT NULL,
  trigger_type VARCHAR(32) NOT NULL DEFAULT 'manual',
  initiated_by_user_id BIGINT UNSIGNED NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'running',
  request_params JSON NULL,
  received_count INT UNSIGNED NOT NULL DEFAULT 0,
  imported_count INT UNSIGNED NOT NULL DEFAULT 0,
  skipped_count INT UNSIGNED NOT NULL DEFAULT 0,
  failed_count INT UNSIGNED NOT NULL DEFAULT 0,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3) NULL,
  error_message TEXT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sync_runs_operation (operation_id),
  KEY idx_sync_runs_started (started_at),
  KEY idx_sync_runs_user (initiated_by_user_id),
  CONSTRAINT fk_sync_runs_user FOREIGN KEY (initiated_by_user_id) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS import_operations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  bank_transaction_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  account_number VARCHAR(64) NULL,
  receipt_id BIGINT UNSIGNED NULL,
  amount DECIMAL(20,2) NULL,
  currency CHAR(3) NULL,
  payment_at DATETIME(3) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_import_transaction (account_number, bank_transaction_id),
  KEY idx_import_status_updated (status, updated_at),
  KEY idx_import_receipt (receipt_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sync_run_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sync_run_id BIGINT UNSIGNED NOT NULL,
  import_operation_id BIGINT UNSIGNED NULL,
  bank_transaction_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  status VARCHAR(32) NOT NULL,
  error_message TEXT NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_sync_items_run_status (sync_run_id, status),
  KEY idx_sync_items_transaction (bank_transaction_id),
  CONSTRAINT fk_sync_items_run FOREIGN KEY (sync_run_id) REFERENCES sync_runs (id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_sync_items_import FOREIGN KEY (import_operation_id) REFERENCES import_operations (id)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS activity_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  legacy_id VARCHAR(128) NULL,
  operation_id CHAR(36) NULL,
  event_type VARCHAR(64) NOT NULL,
  receipt_id BIGINT UNSIGNED NULL,
  deal_id BIGINT UNSIGNED NULL,
  bank_transaction_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  receipt_title VARCHAR(255) NULL,
  amount DECIMAL(20,2) NULL,
  currency CHAR(3) NULL,
  action_text VARCHAR(500) NOT NULL,
  actor_type VARCHAR(32) NOT NULL DEFAULT 'system',
  actor_name VARCHAR(255) NULL,
  metadata JSON NULL,
  occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_activity_legacy_id (legacy_id),
  KEY idx_activity_occurred (occurred_at),
  KEY idx_activity_receipt (receipt_id, occurred_at),
  KEY idx_activity_deal (deal_id, occurred_at),
  KEY idx_activity_operation (operation_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  operation_id CHAR(36) NULL,
  user_id BIGINT UNSIGNED NULL,
  session_id BIGINT UNSIGNED NULL,
  actor_type VARCHAR(32) NOT NULL DEFAULT 'system',
  actor_name VARCHAR(255) NULL,
  action VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  receipt_id BIGINT UNSIGNED NULL,
  deal_id BIGINT UNSIGNED NULL,
  before_data JSON NULL,
  after_data JSON NULL,
  error_code VARCHAR(64) NULL,
  error_message TEXT NULL,
  ip_address VARBINARY(16) NULL,
  user_agent VARCHAR(500) NULL,
  occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_audit_user_time (user_id, occurred_at),
  KEY idx_audit_action_time (action, occurred_at),
  KEY idx_audit_operation (operation_id),
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_audit_session FOREIGN KEY (session_id) REFERENCES user_sessions (id)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;
