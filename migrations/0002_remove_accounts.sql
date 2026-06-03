CREATE TABLE IF NOT EXISTS pair_rooms_new (
  code TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT INTO pair_rooms_new (code, expires_at, created_at)
SELECT code, expires_at, created_at FROM pair_rooms;

DROP TABLE pair_rooms;
ALTER TABLE pair_rooms_new RENAME TO pair_rooms;

CREATE INDEX IF NOT EXISTS idx_pair_rooms_expires_at ON pair_rooms(expires_at);

DROP TABLE IF EXISTS devices;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;
