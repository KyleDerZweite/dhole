CREATE TABLE account_grants (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('invitation', 'password_reset')),
  team_id TEXT NOT NULL REFERENCES teams(id),
  user_id TEXT REFERENCES users(id),
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('administrator', 'member')),
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  CHECK ((kind = 'invitation' AND user_id IS NULL) OR (kind = 'password_reset' AND user_id IS NOT NULL))
);
CREATE UNIQUE INDEX account_grants_invitation_active ON account_grants(team_id, email)
  WHERE kind = 'invitation' AND consumed_at IS NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX account_grants_reset_active ON account_grants(user_id)
  WHERE kind = 'password_reset' AND consumed_at IS NULL AND revoked_at IS NULL;
