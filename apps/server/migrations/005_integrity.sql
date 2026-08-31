-- Coordination module auxiliary state. These rows used to be created lazily by
-- CoordinationService; keeping them in the schema makes startup deterministic
-- and lets migrations own their integrity guarantees.
CREATE TABLE IF NOT EXISTS coordination_repo_reports (
  session_id TEXT PRIMARY KEY REFERENCES coordination_sessions(id) ON DELETE CASCADE,
  branch TEXT,
  revision TEXT,
  dirty_files_json TEXT NOT NULL DEFAULT '[]',
  reported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coordination_claim_settlements (
  claim_id TEXT PRIMARY KEY REFERENCES coordination_claims(id) ON DELETE CASCADE,
  commits_json TEXT NOT NULL DEFAULT '[]',
  prs_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS coordination_agent_executions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT,
  run_hash TEXT NOT NULL,
  agent_hash TEXT NOT NULL,
  parent_hash TEXT,
  parent_execution_id TEXT,
  harness TEXT NOT NULL,
  name TEXT,
  role TEXT,
  task TEXT,
  state TEXT NOT NULL,
  state_reason TEXT,
  provenance TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE(project_id, run_hash, agent_hash)
);

CREATE TABLE IF NOT EXISTS coordination_agent_events (
  project_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  execution_id TEXT NOT NULL REFERENCES coordination_agent_executions(id) ON DELETE CASCADE,
  payload_hash TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY(project_id, event_id)
);

CREATE INDEX IF NOT EXISTS coordination_claim_files_lookup ON coordination_claim_files(normalized_path);
CREATE INDEX IF NOT EXISTS coordination_claim_components_lookup ON coordination_claim_components(normalized_component);

-- Migration 001 allowed multiple NULL adapters for one native event because
-- SQLite treats NULLs as distinct in a UNIQUE index. Normalize the adapter so
-- native event identifiers are truly idempotent when the adapter is omitted.
DROP INDEX IF EXISTS event_native_id;
CREATE UNIQUE INDEX event_native_id
  ON event_log(project_id, COALESCE(source_adapter, ''), source_native_event_id)
  WHERE source_native_event_id IS NOT NULL;

-- Current-state rows may otherwise cascade-delete immutable audit/event history
-- through the legacy project/team foreign keys. Keep history append-only even
-- when a caller issues raw DELETE statements instead of using an API service.
CREATE TRIGGER event_history_project_delete_guard
BEFORE DELETE ON projects
WHEN EXISTS (SELECT 1 FROM event_log WHERE project_id = old.id)
  OR EXISTS (SELECT 1 FROM audit_records WHERE project_id = old.id)
BEGIN
  SELECT RAISE(ABORT, 'cannot delete project with immutable history');
END;

CREATE TRIGGER event_history_team_delete_guard
BEFORE DELETE ON teams
WHEN EXISTS (
  SELECT 1
  FROM projects p
  WHERE p.team_id = old.id
    AND (
      EXISTS (SELECT 1 FROM event_log WHERE project_id = p.id)
      OR EXISTS (SELECT 1 FROM audit_records WHERE project_id = p.id)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'cannot delete team with immutable history');
END;

-- active_generation_id is a logical reference (it cannot be a normal FK due
-- to the cyclic pack/generation creation flow). Enforce the same ownership
-- invariant for inserts and prevent deleting a generation still selected by a
-- pack; the existing update trigger covers pointer changes.
CREATE TRIGGER memory_pack_active_generation_valid_insert
BEFORE INSERT ON memory_packs
WHEN new.active_generation_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM memory_generations g WHERE g.id = new.active_generation_id AND g.pack_id = new.id
  ) THEN RAISE(ABORT, 'active generation must belong to memory pack') END;
END;

CREATE TRIGGER memory_generation_active_delete
BEFORE DELETE ON memory_generations
WHEN EXISTS (
  SELECT 1 FROM memory_packs p WHERE p.active_generation_id = old.id
) BEGIN
  SELECT RAISE(ABORT, 'cannot delete active memory generation');
END;
