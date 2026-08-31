CREATE TABLE memory_packs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stable_key TEXT NOT NULL,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('project', 'role', 'phase')),
  scope_key TEXT,
  active_generation_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, stable_key)
);

CREATE TABLE memory_generations (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES memory_packs(id) ON DELETE CASCADE,
  parent_generation_id TEXT REFERENCES memory_generations(id),
  generation INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft', 'approved', 'active', 'archived')),
  fold_reason TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  activated_at TEXT,
  archived_at TEXT,
  UNIQUE (pack_id, generation),
  UNIQUE (pack_id, content_hash)
);

CREATE TABLE memory_entries (
  id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES memory_generations(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_reference TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (generation_id, ordinal),
  UNIQUE (generation_id, content_hash)
);

CREATE TRIGGER memory_entries_immutable_update
BEFORE UPDATE ON memory_entries BEGIN
  SELECT RAISE(ABORT, 'memory entries are immutable');
END;

CREATE TRIGGER memory_entries_immutable_delete
BEFORE DELETE ON memory_entries BEGIN
  SELECT RAISE(ABORT, 'memory entries are immutable');
END;

CREATE TABLE memory_proposals (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES memory_packs(id) ON DELETE CASCADE,
  base_generation_id TEXT REFERENCES memory_generations(id),
  proposed_by_user_id TEXT REFERENCES users(id),
  proposed_by_activation_id TEXT REFERENCES agent_activations(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_reference TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected')),
  decided_by TEXT REFERENCES users(id),
  decision_reason TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE memory_activation_history (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES memory_packs(id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL REFERENCES memory_generations(id),
  activated_by TEXT NOT NULL REFERENCES users(id),
  activated_at TEXT NOT NULL,
  deactivated_at TEXT
);

CREATE VIRTUAL TABLE memory_fts USING fts5(entry_id UNINDEXED, generation_id UNINDEXED, title, body, tokenize = 'unicode61');

CREATE TRIGGER memory_entries_fts_insert AFTER INSERT ON memory_entries BEGIN
  INSERT INTO memory_fts(entry_id, generation_id, title, body)
  VALUES (new.id, new.generation_id, new.title, new.body);
END;

CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  stable_key TEXT NOT NULL,
  name TEXT NOT NULL,
  active_version_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, stable_key)
);

CREATE TABLE skill_versions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('draft', 'benchmarked', 'canary', 'active', 'deprecated')),
  skill_markdown TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  proposed_by_user_id TEXT REFERENCES users(id),
  proposed_by_activation_id TEXT REFERENCES agent_activations(id),
  created_at TEXT NOT NULL,
  UNIQUE (skill_id, version),
  UNIQUE (skill_id, content_hash)
);

CREATE TABLE benchmarks (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  stable_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('skill', 'orchestration', 'model', 'memory')),
  name TEXT NOT NULL,
  fixture_hash TEXT NOT NULL,
  scorer_version TEXT NOT NULL,
  dimensions_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, stable_key, version)
);

CREATE TABLE benchmark_cases (
  id TEXT PRIMARY KEY,
  benchmark_id TEXT NOT NULL REFERENCES benchmarks(id) ON DELETE CASCADE,
  case_key TEXT NOT NULL,
  prompt TEXT NOT NULL,
  expected_json TEXT NOT NULL,
  fixture_json TEXT NOT NULL,
  fixture_hash TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  UNIQUE (benchmark_id, case_key)
);

CREATE TABLE benchmark_runs (
  id TEXT PRIMARY KEY,
  benchmark_id TEXT NOT NULL REFERENCES benchmarks(id) ON DELETE CASCADE,
  baseline_config_json TEXT NOT NULL,
  candidate_config_json TEXT NOT NULL,
  environment_hash TEXT NOT NULL,
  seed TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE benchmark_case_runs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL REFERENCES benchmark_cases(id),
  variant TEXT NOT NULL CHECK (variant IN ('baseline', 'candidate')),
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'error')),
  output_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  estimated_cost_microusd INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, case_id, variant, attempt)
);

CREATE TABLE benchmark_dimension_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  case_run_id TEXT REFERENCES benchmark_case_runs(id) ON DELETE CASCADE,
  variant TEXT NOT NULL CHECK (variant IN ('baseline', 'candidate', 'comparison')),
  dimension TEXT NOT NULL,
  numeric_value REAL,
  boolean_value INTEGER CHECK (boolean_value IN (0, 1)),
  text_value TEXT,
  evidence_json TEXT NOT NULL,
  scorer_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE promotion_decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('skill', 'memory', 'model', 'orchestration')),
  subject_version_id TEXT NOT NULL,
  benchmark_run_id TEXT REFERENCES benchmark_runs(id),
  decision TEXT NOT NULL CHECK (decision IN ('promote', 'reject', 'canary')),
  reason TEXT NOT NULL,
  decided_by TEXT NOT NULL REFERENCES users(id),
  decided_at TEXT NOT NULL
);

CREATE TABLE model_capability_probes (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('supported', 'unsupported', 'unknown')),
  latency_ms INTEGER,
  error_summary TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  observed_at TEXT NOT NULL
);

CREATE TRIGGER memory_pack_active_generation_valid
BEFORE UPDATE OF active_generation_id ON memory_packs
WHEN new.active_generation_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM memory_generations g WHERE g.id = new.active_generation_id AND g.pack_id = new.id
  ) THEN RAISE(ABORT, 'active generation must belong to memory pack') END;
END;
