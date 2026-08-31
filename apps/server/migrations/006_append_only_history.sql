-- Event and audit rows are immutable history. The outbox marker is the one
-- intentionally mutable event column: EventStore sets it after listeners have
-- observed a committed event.
CREATE TRIGGER event_log_append_only_delete
BEFORE DELETE ON event_log BEGIN
  SELECT RAISE(ABORT, 'event history is append-only');
END;

CREATE TRIGGER event_log_immutable_update
BEFORE UPDATE OF
  event_id,
  project_id,
  project_sequence,
  event_kind,
  schema_version,
  aggregate_type,
  aggregate_id,
  parent_aggregate_id,
  actor_type,
  actor_id,
  source_kind,
  source_adapter,
  source_native_event_id,
  raw_reference,
  idempotency_key,
  payload_json,
  occurred_at
ON event_log BEGIN
  SELECT RAISE(ABORT, 'event history is append-only');
END;

CREATE TRIGGER audit_records_append_only_delete
BEFORE DELETE ON audit_records BEGIN
  SELECT RAISE(ABORT, 'audit history is append-only');
END;

CREATE TRIGGER audit_records_immutable_update
BEFORE UPDATE OF
  id,
  project_id,
  actor_type,
  actor_id,
  action,
  target_type,
  target_id,
  outcome,
  detail_json,
  occurred_at
ON audit_records BEGIN
  SELECT RAISE(ABORT, 'audit history is append-only');
END;

-- Agent execution/event rows are compatibility state without foreign keys to
-- projects and without a composite project/execution key. Keep those logical
-- relationships enforced at the database boundary.
CREATE TRIGGER coordination_agent_execution_integrity_insert
BEFORE INSERT ON coordination_agent_executions
WHEN NOT EXISTS (SELECT 1 FROM projects WHERE id = new.project_id)
  OR (
    new.session_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM coordination_sessions
      WHERE id = new.session_id AND project_id = new.project_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'coordination execution project/session mismatch');
END;

CREATE TRIGGER coordination_agent_execution_integrity_update
BEFORE UPDATE OF project_id, session_id ON coordination_agent_executions
WHEN NOT EXISTS (SELECT 1 FROM projects WHERE id = new.project_id)
  OR (
    new.session_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM coordination_sessions
      WHERE id = new.session_id AND project_id = new.project_id
    )
  )
  OR EXISTS (
    SELECT 1 FROM coordination_agent_events
    WHERE execution_id = old.id AND project_id <> new.project_id
  )
BEGIN
  SELECT RAISE(ABORT, 'coordination execution project/session mismatch');
END;

CREATE TRIGGER coordination_agent_event_integrity_insert
BEFORE INSERT ON coordination_agent_events
WHEN NOT EXISTS (
  SELECT 1 FROM coordination_agent_executions
  WHERE id = new.execution_id AND project_id = new.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'coordination event project/execution mismatch');
END;

CREATE TRIGGER coordination_agent_event_integrity_update
BEFORE UPDATE OF project_id, execution_id ON coordination_agent_events
WHEN NOT EXISTS (
  SELECT 1 FROM coordination_agent_executions
  WHERE id = new.execution_id AND project_id = new.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'coordination event project/execution mismatch');
END;

-- The auxiliary tables intentionally retain their legacy shape, so protect
-- the two optional relationships on deletes as well as inserts/updates.
CREATE TRIGGER coordination_agent_execution_project_delete_guard
BEFORE DELETE ON projects
WHEN EXISTS (
  SELECT 1 FROM coordination_agent_executions
  WHERE project_id = old.id
)
BEGIN
  SELECT RAISE(ABORT, 'cannot delete project with coordination executions');
END;

CREATE TRIGGER coordination_session_execution_delete_guard
BEFORE DELETE ON coordination_sessions
WHEN EXISTS (
  SELECT 1 FROM coordination_agent_executions
  WHERE session_id = old.id
)
BEGIN
  SELECT RAISE(ABORT, 'cannot delete coordination session with executions');
END;

CREATE TRIGGER coordination_session_execution_integrity_update
BEFORE UPDATE OF id, project_id ON coordination_sessions
WHEN EXISTS (
  SELECT 1 FROM coordination_agent_executions
  WHERE session_id = old.id
    AND (new.id <> old.id OR project_id <> new.project_id)
)
BEGIN
  SELECT RAISE(ABORT, 'coordination session project changed while executions exist');
END;
