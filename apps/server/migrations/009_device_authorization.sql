CREATE TABLE device_authorization_requests (
  id TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code_hash TEXT NOT NULL UNIQUE,
  machine_name TEXT NOT NULL,
  requested_permissions_json TEXT NOT NULL,
  permissions_json TEXT,
  user_id TEXT REFERENCES users(id),
  team_id TEXT REFERENCES teams(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_polled_at TEXT,
  approved_at TEXT,
  revoked_at TEXT,
  consumed_at TEXT
);
CREATE INDEX device_authorization_expiry ON device_authorization_requests(expires_at);

CREATE TABLE user_device_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT NOT NULL REFERENCES teams(id),
  machine_name TEXT NOT NULL,
  machine_id TEXT REFERENCES machines(id),
  token_hash TEXT NOT NULL UNIQUE,
  permissions_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX user_device_tokens_user ON user_device_tokens(user_id, created_at);
ALTER TABLE api_tokens ADD COLUMN device_token_id TEXT REFERENCES user_device_tokens(id);
CREATE INDEX api_tokens_device ON api_tokens(device_token_id);

CREATE TABLE github_repository_bindings (
  team_id TEXT NOT NULL REFERENCES teams(id),
  github_repository_id INTEGER NOT NULL CHECK (github_repository_id > 0),
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
  repository_id TEXT NOT NULL UNIQUE REFERENCES repositories(id),
  verified_at TEXT NOT NULL,
  PRIMARY KEY (team_id, github_repository_id)
);
