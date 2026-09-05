-- A recovery creates a new activation; the original terminal claim is history.
ALTER TABLE coordination_claims ADD COLUMN recovered_from_claim_id TEXT REFERENCES coordination_claims(id);
CREATE UNIQUE INDEX coordination_claim_recovery ON coordination_claims(recovered_from_claim_id)
  WHERE recovered_from_claim_id IS NOT NULL;

CREATE TRIGGER coordination_claim_recovery_project
BEFORE INSERT ON coordination_claims
WHEN new.recovered_from_claim_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM coordination_claims WHERE id = new.recovered_from_claim_id
    AND project_id = new.project_id AND status IN ('expired', 'released')
)
BEGIN
  SELECT RAISE(ABORT, 'claim recovery must reference closed work in the same project');
END;

CREATE TRIGGER coordination_claim_recovery_project_update
BEFORE UPDATE OF recovered_from_claim_id ON coordination_claims
WHEN new.recovered_from_claim_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM coordination_claims WHERE id = new.recovered_from_claim_id
    AND project_id = new.project_id AND status IN ('expired', 'released') AND id <> new.id
)
BEGIN
  SELECT RAISE(ABORT, 'claim recovery must reference closed work in the same project');
END;

CREATE TRIGGER coordination_claim_terminal_history
BEFORE UPDATE ON coordination_claims
WHEN old.status IN ('done', 'abandoned', 'expired', 'released')
BEGIN
  SELECT RAISE(ABORT, 'terminal claim history is immutable');
END;

ALTER TABLE coordination_agent_executions ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE coordination_agent_executions ADD COLUMN scope_run_id TEXT REFERENCES runs(id);
ALTER TABLE coordination_agent_executions ADD COLUMN occurred_at TEXT;
UPDATE coordination_agent_executions SET user_id = (
  SELECT user_id FROM coordination_sessions WHERE id = session_id
), occurred_at = updated_at;
CREATE INDEX coordination_execution_scope ON coordination_agent_executions(project_id, scope_run_id, updated_at);
