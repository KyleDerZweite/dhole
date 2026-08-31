CREATE TABLE node_enrollment_tokens (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by_machine_id TEXT,
  revoked_at TEXT
);

CREATE TABLE machines (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('enrolled', 'connected', 'disconnected', 'stale', 'revoked')),
  daemon_version TEXT,
  available_slots INTEGER NOT NULL DEFAULT 0,
  last_connected_at TEXT,
  last_heartbeat_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (team_id, name)
);

CREATE TABLE device_credentials (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  credential_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  replaced_by TEXT REFERENCES device_credentials(id)
);

CREATE TABLE machine_repository_allowlists (
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  canonical_root TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (machine_id, repository_id)
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('primary', 'worktree')),
  path_reference TEXT NOT NULL,
  branch TEXT,
  head_revision TEXT,
  status TEXT NOT NULL CHECK (status IN ('available', 'leased', 'dirty', 'missing', 'removing')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (machine_id, path_reference)
);

CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  base_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (team_id, name)
);

CREATE TABLE provider_secrets (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  machine_id TEXT REFERENCES machines(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  key_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  rotated_at TEXT,
  revoked_at TEXT,
  UNIQUE (provider_id, machine_id, label)
);

CREATE TABLE models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  declared_capabilities_json TEXT NOT NULL DEFAULT '{}',
  measured_capabilities_json TEXT NOT NULL DEFAULT '{}',
  catalog_observed_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider_id, model_key)
);

CREATE TABLE runtime_registrations (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  executable_reference TEXT,
  observed_version TEXT,
  available INTEGER NOT NULL CHECK (available IN (0, 1)),
  unavailable_reason TEXT,
  observed_at TEXT NOT NULL,
  UNIQUE (machine_id, kind, label)
);

CREATE TABLE node_commands (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'delivered', 'accepted', 'running', 'completed', 'failed', 'uncertain', 'cancelled', 'expired')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  error_summary TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  delivered_at TEXT,
  acknowledged_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (machine_id, operation_key)
);
CREATE INDEX node_commands_delivery ON node_commands(machine_id, state, created_at);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  runtime_registration_id TEXT REFERENCES runtime_registrations(id),
  model_id TEXT REFERENCES models(id),
  workspace_id TEXT REFERENCES workspaces(id),
  state TEXT NOT NULL CHECK (state IN ('idle', 'busy', 'needs_input', 'needs_approval', 'failed', 'cancelled', 'closed')),
  active_turn_id TEXT,
  next_message_sequence INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE session_participants (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL,
  left_at TEXT,
  PRIMARY KEY (session_id, user_id)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  root_objective TEXT NOT NULL,
  issue_reference TEXT,
  claim_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'paused', 'cancelling', 'settled', 'failed', 'cancelled')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE session_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  runtime_turn_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX one_active_turn ON session_turns(session_id) WHERE state = 'running';

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  turn_id TEXT REFERENCES session_turns(id) ON DELETE SET NULL,
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('human', 'agent', 'tool', 'system')),
  author_user_id TEXT REFERENCES users(id),
  logical_agent_id TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'completed', 'failed', 'cancelled')),
  provider_message_id TEXT,
  include_human_identity INTEGER NOT NULL DEFAULT 0 CHECK (include_human_identity IN (0, 1)),
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  completed_at TEXT,
  UNIQUE (session_id, sequence)
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  turn_id TEXT REFERENCES session_turns(id) ON DELETE CASCADE,
  runtime_approval_id TEXT,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail_redacted_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'denied', 'cancelled', 'expired')),
  requested_at TEXT NOT NULL,
  expires_at TEXT,
  answered_by TEXT REFERENCES users(id),
  answered_at TEXT,
  decision TEXT,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE steering_leases (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  holder_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lease_token_hash TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL
);

CREATE TABLE logical_agents (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT,
  objective TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE agent_activations (
  id TEXT PRIMARY KEY,
  logical_agent_id TEXT NOT NULL REFERENCES logical_agents(id) ON DELETE CASCADE,
  machine_id TEXT REFERENCES machines(id),
  runtime_registration_id TEXT REFERENCES runtime_registrations(id),
  workspace_id TEXT REFERENCES workspaces(id),
  native_session_id TEXT,
  ordinal INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'waiting_on_children', 'needs_input', 'needs_approval', 'blocked', 'settled', 'failed', 'cancelled', 'stale')),
  started_at TEXT,
  ended_at TEXT,
  last_activity_at TEXT,
  UNIQUE (logical_agent_id, ordinal)
);

CREATE TABLE agent_edges (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  parent_logical_agent_id TEXT NOT NULL REFERENCES logical_agents(id) ON DELETE CASCADE,
  child_logical_agent_id TEXT NOT NULL REFERENCES logical_agents(id) ON DELETE CASCADE,
  evidence TEXT NOT NULL CHECK (evidence IN ('platform', 'provider', 'hook', 'heuristic')),
  control TEXT NOT NULL CHECK (control IN ('full', 'observe_only', 'uncertain')),
  source_reference TEXT,
  confidence REAL,
  created_at TEXT NOT NULL,
  UNIQUE (parent_logical_agent_id, child_logical_agent_id)
);

CREATE TABLE activity_progress (
  activation_id TEXT NOT NULL REFERENCES agent_activations(id) ON DELETE CASCADE,
  activity_key TEXT NOT NULL,
  label TEXT NOT NULL,
  current_value REAL,
  total_value REAL,
  unit TEXT,
  important INTEGER NOT NULL DEFAULT 0 CHECK (important IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (activation_id, activity_key)
);
