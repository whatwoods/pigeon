-- Migration: Add rate limit table for failed pair attempts
CREATE TABLE IF NOT EXISTS pair_attempts (
  ip TEXT,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pair_attempts_ip_timestamp ON pair_attempts(ip, timestamp);
