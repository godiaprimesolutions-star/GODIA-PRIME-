-- GODIA PRIME CONNECT
-- Migration 0002: Customer plan access

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS gpce_customer_plan_access (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    plan_code TEXT NOT NULL,
    plan_name TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    starts_at TEXT,
    expires_at TEXT,
    payment_id TEXT,
    payment_reference TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id)
        REFERENCES gpce_users(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_gpce_plan_access_user
ON gpce_customer_plan_access(user_id);

CREATE INDEX IF NOT EXISTS idx_gpce_plan_access_status
ON gpce_customer_plan_access(status);

CREATE INDEX IF NOT EXISTS idx_gpce_plan_access_expiry
ON gpce_customer_plan_access(expires_at);

CREATE INDEX IF NOT EXISTS idx_gpce_plan_access_code
ON gpce_customer_plan_access(plan_code);

CREATE INDEX IF NOT EXISTS idx_gpce_plan_access_payment
ON gpce_customer_plan_access(payment_reference);
