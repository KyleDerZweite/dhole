ALTER TABLE gateway_catalog_tokens ADD COLUMN authority_kind TEXT NOT NULL DEFAULT 'legacy' CHECK (authority_kind IN ('legacy', 'user', 'api'));
ALTER TABLE gateway_catalog_tokens ADD COLUMN parent_api_token_id TEXT REFERENCES api_tokens(id);
ALTER TABLE gateway_catalog_tokens ADD COLUMN parent_device_token_id TEXT REFERENCES user_device_tokens(id);
CREATE INDEX gateway_catalog_token_api_parent ON gateway_catalog_tokens(parent_api_token_id);
CREATE INDEX gateway_catalog_token_device_parent ON gateway_catalog_tokens(parent_device_token_id);

-- Earlier tokens did not record whether a browser or delegated credential issued
-- them. Reissue those tokens with explicit authority rather than guessing.
UPDATE gateway_catalog_tokens SET revoked_at = coalesce(revoked_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TRIGGER gateway_catalog_token_authority_immutable
BEFORE UPDATE OF authority_kind, parent_api_token_id, parent_device_token_id, created_by, connection_id, client, token_hash, created_at, expires_at ON gateway_catalog_tokens BEGIN
  SELECT RAISE(ABORT, 'catalog token authority is immutable');
END;
CREATE TRIGGER gateway_catalog_token_revocation_permanent
BEFORE UPDATE OF revoked_at ON gateway_catalog_tokens
WHEN old.revoked_at IS NOT NULL AND new.revoked_at IS NOT old.revoked_at BEGIN
  SELECT RAISE(ABORT, 'catalog token revocation is permanent');
END;
CREATE TRIGGER gateway_catalog_token_authority_insert
BEFORE INSERT ON gateway_catalog_tokens
WHEN new.authority_kind = 'legacy'
  OR (new.authority_kind = 'user' AND (new.parent_api_token_id IS NOT NULL OR new.parent_device_token_id IS NOT NULL))
  OR (new.authority_kind = 'api' AND (new.parent_api_token_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM api_tokens a JOIN projects p ON p.id = a.project_id JOIN gateway_connections c ON c.id = new.connection_id
    WHERE a.id = new.parent_api_token_id AND a.user_id = new.created_by AND p.team_id = c.team_id
      AND a.device_token_id IS new.parent_device_token_id AND a.run_id IS NULL
  ))) BEGIN
  SELECT RAISE(ABORT, 'catalog token parent authority mismatch');
END;

CREATE TRIGGER gateway_catalog_parent_api_revoked
AFTER UPDATE OF revoked_at, scopes_json, run_id, user_id, project_id, device_token_id ON api_tokens
WHEN new.revoked_at IS NOT NULL OR new.scopes_json IS NOT old.scopes_json OR new.run_id IS NOT old.run_id
  OR new.user_id IS NOT old.user_id OR new.project_id IS NOT old.project_id OR new.device_token_id IS NOT old.device_token_id BEGIN
  UPDATE gateway_catalog_tokens SET revoked_at = coalesce(new.revoked_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHERE parent_api_token_id = new.id AND revoked_at IS NULL;
END;
CREATE TRIGGER gateway_catalog_parent_device_revoked
AFTER UPDATE OF revoked_at, permissions_json, user_id, team_id ON user_device_tokens
WHEN new.revoked_at IS NOT NULL OR new.permissions_json IS NOT old.permissions_json OR new.user_id IS NOT old.user_id OR new.team_id IS NOT old.team_id BEGIN
  UPDATE gateway_catalog_tokens SET revoked_at = coalesce(new.revoked_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHERE parent_device_token_id = new.id AND revoked_at IS NULL;
END;

CREATE TRIGGER gateway_catalog_native_account_reset
AFTER UPDATE OF password_hash, disabled_at ON users
WHEN new.password_hash IS NOT old.password_hash OR new.disabled_at IS NOT NULL BEGIN
  UPDATE gateway_catalog_tokens SET revoked_at = coalesce(new.disabled_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHERE created_by = new.id AND revoked_at IS NULL;
END;
CREATE TRIGGER gateway_catalog_administrator_removed
AFTER UPDATE OF role ON team_members WHEN old.role = 'administrator' AND new.role <> 'administrator' BEGIN
  UPDATE gateway_catalog_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE created_by = old.user_id AND connection_id IN (SELECT id FROM gateway_connections WHERE team_id = old.team_id) AND revoked_at IS NULL;
END;
CREATE TRIGGER gateway_catalog_membership_removed
AFTER DELETE ON team_members BEGIN
  UPDATE gateway_catalog_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE created_by = old.user_id AND connection_id IN (SELECT id FROM gateway_connections WHERE team_id = old.team_id) AND revoked_at IS NULL;
END;
