CREATE TABLE IF NOT EXISTS turn_rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_turn_rate_limits_window ON turn_rate_limits(window_start);
