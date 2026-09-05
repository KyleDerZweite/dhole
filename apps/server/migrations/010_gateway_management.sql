ALTER TABLE gateway_connections ADD COLUMN provider_id TEXT REFERENCES providers(id);
ALTER TABLE gateway_connections ADD COLUMN catalog_secret_id TEXT REFERENCES provider_secrets(id);
ALTER TABLE gateway_connections ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE gateway_connections ADD COLUMN archived_at TEXT;
ALTER TABLE gateway_connections ADD COLUMN deleted_at TEXT;
UPDATE gateway_connections SET provider_id = (
  SELECT id FROM providers WHERE id = gateway_connections.id || ':provider' AND team_id = gateway_connections.team_id
);

CREATE TABLE gateway_connection_revisions (
  connection_id TEXT NOT NULL REFERENCES gateway_connections(id),
  revision INTEGER NOT NULL,
  action TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  actor_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, revision)
);
CREATE TRIGGER gateway_connection_revisions_immutable_update
BEFORE UPDATE ON gateway_connection_revisions BEGIN
  SELECT RAISE(ABORT, 'gateway connection revisions are immutable');
END;
CREATE TRIGGER gateway_connection_revisions_immutable_delete
BEFORE DELETE ON gateway_connection_revisions BEGIN
  SELECT RAISE(ABORT, 'gateway connection revisions are immutable');
END;

CREATE TABLE gateway_management_revisions (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES gateway_connections(id),
  action TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'failed')),
  actor_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TRIGGER gateway_management_revisions_immutable_update
BEFORE UPDATE ON gateway_management_revisions BEGIN
  SELECT RAISE(ABORT, 'gateway management revisions are immutable');
END;
CREATE TRIGGER gateway_management_revisions_immutable_delete
BEFORE DELETE ON gateway_management_revisions BEGIN
  SELECT RAISE(ABORT, 'gateway management revisions are immutable');
END;

ALTER TABLE gateway_accounts ADD COLUMN management_supported INTEGER NOT NULL DEFAULT 0 CHECK (management_supported IN (0, 1));
ALTER TABLE gateway_accounts ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1));

CREATE TABLE gateway_oauth_flows (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES gateway_connections(id),
  connection_revision INTEGER NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL CHECK (provider IN ('codex', 'anthropic', 'antigravity')),
  encrypted_state_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'submitted', 'complete', 'cancelled', 'error', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
