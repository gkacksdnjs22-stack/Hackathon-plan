PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS gil_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gil_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES gil_users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS gil_sessions_expiry ON gil_sessions(expires_at);
CREATE INDEX IF NOT EXISTS gil_sessions_user ON gil_sessions(user_id);

CREATE TABLE IF NOT EXISTS gil_rate_limits (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK(attempts > 0)
);
CREATE INDEX IF NOT EXISTS gil_rate_limits_window ON gil_rate_limits(window_start);

CREATE TABLE IF NOT EXISTS gil_plans (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES gil_users(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 80),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND length(CAST(document_json AS BLOB)) <= 262144),
  city_id TEXT NOT NULL,
  start_date TEXT NOT NULL,
  day_count INTEGER NOT NULL CHECK(day_count BETWEEN 1 AND 7),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS gil_plans_owner_updated ON gil_plans(user_id, updated_at DESC, id);
