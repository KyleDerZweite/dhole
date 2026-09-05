CREATE TABLE gateway_catalog_snapshots (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES gateway_connections(id),
  provider_id TEXT NOT NULL REFERENCES providers(id),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  source_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  models_json TEXT NOT NULL,
  diff_json TEXT NOT NULL
);
CREATE INDEX gateway_catalog_snapshot_history ON gateway_catalog_snapshots(connection_id, observed_at DESC);
CREATE TRIGGER gateway_catalog_snapshot_immutable_update BEFORE UPDATE ON gateway_catalog_snapshots BEGIN
  SELECT RAISE(ABORT, 'catalog snapshots are immutable');
END;
CREATE TRIGGER gateway_catalog_snapshot_immutable_delete BEFORE DELETE ON gateway_catalog_snapshots BEGIN
  SELECT RAISE(ABORT, 'catalog snapshots are immutable');
END;

CREATE TABLE gateway_catalog_state (
  connection_id TEXT PRIMARY KEY REFERENCES gateway_connections(id),
  snapshot_id TEXT REFERENCES gateway_catalog_snapshots(id),
  last_attempt_at TEXT NOT NULL,
  last_success_at TEXT,
  error_code TEXT
);

CREATE TABLE gateway_catalog_tokens (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES gateway_connections(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  client TEXT NOT NULL CHECK (client IN ('generic', 'opencode', 'codex')),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
