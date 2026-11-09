-- GODIA PRIME CONNECT
-- Migration 0001: Initial database

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS gpce_users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    phone TEXT NOT NULL UNIQUE,
    pin_salt TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS gpce_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    FOREIGN KEY (user_id)
        REFERENCES gpce_users(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS gpce_payments (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    phone TEXT NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'KES',
    status TEXT NOT NULL DEFAULT 'PENDING',
    merchant_request_id TEXT,
    checkout_request_id TEXT UNIQUE,
    result_code INTEGER,
    result_description TEXT,
    mpesa_receipt TEXT,
    confirmed_amount REAL,
    confirmed_phone TEXT,
    callback_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id)
        REFERENCES gpce_users(id)
        ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_gpce_sessions_user_id
ON gpce_sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_gpce_sessions_expiry
ON gpce_sessions(expires_at);

CREATE INDEX IF NOT EXISTS idx_gpce_payments_user_id
ON gpce_payments(user_id);

CREATE INDEX IF NOT EXISTS idx_gpce_payments_status
ON gpce_payments(status);

CREATE INDEX IF NOT EXISTS idx_gpce_payments_phone
ON gpce_payments(phone);

CREATE INDEX IF NOT EXISTS idx_gpce_payments_created_at
ON gpce_payments(created_at);
