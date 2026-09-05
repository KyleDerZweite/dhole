ALTER TABLE projects ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'
  CHECK (visibility IN ('private', 'team'));

-- Preserve the previous team-wide policy only for projects that already exist.
UPDATE projects SET visibility = 'team';

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user ON project_members(user_id, project_id);

CREATE TRIGGER project_member_team_insert
BEFORE INSERT ON project_members
WHEN NOT EXISTS (
  SELECT 1 FROM projects p JOIN team_members tm ON tm.team_id = p.team_id
  WHERE p.id = new.project_id AND tm.user_id = new.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'project member must belong to the project team');
END;

CREATE TRIGGER project_member_team_update
BEFORE UPDATE OF project_id, user_id ON project_members
WHEN NOT EXISTS (
  SELECT 1 FROM projects p JOIN team_members tm ON tm.team_id = p.team_id
  WHERE p.id = new.project_id AND tm.user_id = new.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'project member must belong to the project team');
END;
