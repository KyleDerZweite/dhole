CREATE TABLE coordination_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  machine_id TEXT REFERENCES machines(id) ON DELETE CASCADE,
  agent_label TEXT NOT NULL,
  developer_label TEXT,
  worktree_hash TEXT,
  capability_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE coordination_claims (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  coordination_session_id TEXT NOT NULL REFERENCES coordination_sessions(id),
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  work_item_id TEXT,
  intent TEXT NOT NULL,
  task TEXT,
  worktree_hash TEXT,
  branch TEXT,
  base_revision TEXT,
  status TEXT NOT NULL CHECK (status IN ('investigating', 'in-progress', 'testing', 'blocked', 'done', 'abandoned', 'expired', 'released')),
  blocked_on TEXT REFERENCES coordination_claims(id),
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX active_claims ON coordination_claims(project_id, status, updated_at);

CREATE TABLE coordination_claim_files (
  claim_id TEXT NOT NULL REFERENCES coordination_claims(id) ON DELETE CASCADE,
  normalized_path TEXT NOT NULL,
  PRIMARY KEY (claim_id, normalized_path)
);

CREATE TABLE coordination_claim_components (
  claim_id TEXT NOT NULL REFERENCES coordination_claims(id) ON DELETE CASCADE,
  normalized_component TEXT NOT NULL,
  PRIMARY KEY (claim_id, normalized_component)
);

CREATE TABLE coordination_findings (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES coordination_claims(id) ON DELETE CASCADE,
  kind TEXT CHECK (kind IN ('root-cause', 'gotcha', 'decision', 'api-change')),
  text TEXT NOT NULL,
  files_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE coordination_conflicts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  claim_id TEXT NOT NULL REFERENCES coordination_claims(id) ON DELETE CASCADE,
  conflicting_claim_id TEXT NOT NULL REFERENCES coordination_claims(id) ON DELETE CASCADE,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'blocking')),
  reasons_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE (claim_id, conflicting_claim_id)
);

CREATE TABLE worktrees (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  machine_id TEXT NOT NULL REFERENCES machines(id),
  workspace_id TEXT REFERENCES workspaces(id),
  work_item_id TEXT,
  path_reference TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_revision TEXT,
  state TEXT NOT NULL CHECK (state IN ('requested', 'creating', 'ready', 'in_use', 'settled', 'removing', 'removed', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (machine_id, path_reference)
);

CREATE TABLE gateway_connections (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  secret_id TEXT REFERENCES provider_secrets(id),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('unknown', 'healthy', 'degraded', 'unavailable')),
  last_checked_at TEXT,
  last_error_summary TEXT,
  retention_days INTEGER NOT NULL DEFAULT 30,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (team_id, name)
);

CREATE TABLE gateway_accounts (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES gateway_connections(id) ON DELETE CASCADE,
  auth_index TEXT NOT NULL,
  provider TEXT NOT NULL,
  label TEXT,
  masked_source TEXT,
  status TEXT NOT NULL,
  status_message TEXT,
  quota_json TEXT NOT NULL DEFAULT '{}',
  cooldown_until TEXT,
  observed_at TEXT NOT NULL,
  UNIQUE (connection_id, auth_index)
);

CREATE TABLE gateway_requests (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES gateway_connections(id) ON DELETE CASCADE,
  event_hash TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  request_id TEXT,
  occurred_at TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  requested_model TEXT,
  account_id TEXT REFERENCES gateway_accounts(id),
  auth_index TEXT,
  endpoint TEXT,
  status_code INTEGER,
  failed INTEGER NOT NULL CHECK (failed IN (0, 1)),
  failure_category TEXT,
  failure_summary TEXT,
  duration_ms INTEGER,
  ttft_ms INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_microusd INTEGER,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  correlation_confidence TEXT CHECK (correlation_confidence IN ('exact', 'high', 'medium', 'low', 'none')),
  correlation_reason TEXT,
  trace_reference TEXT,
  redacted_metadata_json TEXT NOT NULL DEFAULT '{}',
  ingested_at TEXT NOT NULL,
  UNIQUE (connection_id, event_hash)
);
CREATE INDEX gateway_requests_filters ON gateway_requests(connection_id, occurred_at DESC, provider, model);

CREATE TABLE gateway_price_overrides (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES gateway_connections(id) ON DELETE CASCADE,
  model_pattern TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  prompt_microusd_per_million INTEGER,
  completion_microusd_per_million INTEGER,
  cache_read_microusd_per_million INTEGER,
  cache_create_microusd_per_million INTEGER,
  context_threshold_tokens INTEGER,
  service_tier TEXT,
  source TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE orchestration_profiles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stable_key TEXT NOT NULL,
  name TEXT NOT NULL,
  active_version INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, stable_key)
);

CREATE TABLE orchestration_profile_versions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES orchestration_profiles(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  config_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('draft', 'active', 'deprecated')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (profile_id, version),
  UNIQUE (profile_id, content_hash)
);

CREATE TABLE orchestration_executions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  profile_version_id TEXT NOT NULL REFERENCES orchestration_profile_versions(id),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'paused', 'cancelling', 'settled', 'failed', 'cancelled')),
  max_concurrency INTEGER NOT NULL,
  active_count INTEGER NOT NULL DEFAULT 0,
  scheduler_lease_owner TEXT,
  scheduler_lease_expires_at TEXT,
  pause_requested_at TEXT,
  cancel_requested_at TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id)
);

CREATE TABLE orchestration_work_items (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES orchestration_executions(id) ON DELETE CASCADE,
  parent_work_item_id TEXT REFERENCES orchestration_work_items(id) ON DELETE CASCADE,
  logical_agent_id TEXT REFERENCES logical_agents(id),
  activation_id TEXT REFERENCES agent_activations(id),
  claim_id TEXT REFERENCES coordination_claims(id),
  machine_id TEXT REFERENCES machines(id),
  workspace_id TEXT REFERENCES workspaces(id),
  objective TEXT NOT NULL,
  deliverables_json TEXT NOT NULL,
  acceptance_json TEXT NOT NULL,
  required_capabilities_json TEXT NOT NULL,
  claim_scope_json TEXT NOT NULL,
  workspace_policy TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  depth INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('queued', 'blocked', 'claiming', 'scheduled', 'running', 'needs_input', 'reviewing', 'settled', 'failed', 'cancelled')),
  result_json TEXT,
  error_summary TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (execution_id, ordinal)
);

CREATE TABLE orchestration_dependencies (
  work_item_id TEXT NOT NULL REFERENCES orchestration_work_items(id) ON DELETE CASCADE,
  depends_on_work_item_id TEXT NOT NULL REFERENCES orchestration_work_items(id) ON DELETE CASCADE,
  PRIMARY KEY (work_item_id, depends_on_work_item_id),
  CHECK (work_item_id <> depends_on_work_item_id)
);
