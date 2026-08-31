import { createHash } from 'node:crypto';
import { HttpError } from '../../lib/http.js';
import type { DatabaseConnection } from '../../lib/database.js';
import { secureIds, systemClock } from '../../lib/clock.js';
import type { Clock, IdSource } from '../../lib/clock.js';
import { redactSecrets } from '../../lib/security.js';
import {
  SkillLifecycleInputSchema,
  SkillManifestSchema,
  SkillProposalActorSchema,
  SkillProposalInputSchema,
  type Skill,
  type SkillLifecycle,
  type SkillManifest,
  type SkillProposalActor,
  type SkillProposalInput,
  type SkillVersion,
} from './types.js';
import { parseSkillMarkdown } from './parser.js';

export class SkillAuthorizationError extends HttpError {
  readonly statusCode = 403;
  constructor(message = 'You are not authorized to access this skill') {
    super(403, 'skill_authorization_denied', message);
    this.name = 'SkillAuthorizationError';
  }
}

export class SkillContentError extends Error {
  readonly code = 'skill_secret_forbidden';
  readonly statusCode = 422;
  constructor() {
    super('Skill markdown must not contain credentials');
    this.name = 'SkillContentError';
  }
}

interface SkillRow {
  id: string;
  project_id: string | null;
  stable_key: string;
  name: string;
  active_version_id: string | null;
  created_at: string;
}

interface VersionRow {
  id: string;
  skill_id: string;
  version: number;
  lifecycle: SkillLifecycle;
  skill_markdown: string;
  manifest_json: string;
  content_hash: string;
  proposed_by_user_id: string | null;
  proposed_by_activation_id: string | null;
  created_at: string;
}

export class SkillsService {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly clock: Clock = systemClock,
    private readonly ids: IdSource = secureIds,
  ) {}

  propose(input: SkillProposalInput, actor: SkillProposalActor | string): SkillVersion {
    const parsed = SkillProposalInputSchema.parse(input);
    if (redactSecrets(parsed.markdown, parsed.markdown.length) !== parsed.markdown) throw new SkillContentError();
    const normalizedActor = typeof actor === 'string' ? { type: 'user' as const, userId: actor } : SkillProposalActorSchema.parse(actor);
    const projectId = parsed.projectId ?? null;
    if (projectId) {
      if (normalizedActor.type === 'user') this.assertProjectAccess(projectId, normalizedActor.userId);
      else this.assertActivationAccess(projectId, normalizedActor.activationId);
    } else if (normalizedActor.type === 'user') {
      this.assertAdministrator(normalizedActor.userId);
    } else {
      throw new SkillAuthorizationError('Global skills may only be proposed by a user');
    }
    const parsedSkill = parseSkillMarkdown(parsed.markdown, {
      ...(parsed.directory === undefined ? {} : { directory: parsed.directory }),
      ...(parsed.references === undefined ? {} : { references: parsed.references }),
    });
    if (parsedSkill.manifest.name !== parsed.stableKey) throw new Error('Skill stableKey must match frontmatter name');
    const now = this.clock.now().toISOString();
    return this.database.transaction(() => {
      let skill = this.findSkill(projectId, parsed.stableKey);
      if (!skill) {
        const skillId = this.ids.id();
        this.database.prepare('INSERT INTO skills(id, project_id, stable_key, name, created_at) VALUES (?, ?, ?, ?, ?)').run(skillId, projectId, parsed.stableKey, parsedSkill.manifest.name, now);
        skill = this.getSkill(skillId)!;
      }
      const latest = this.database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM skill_versions WHERE skill_id = ?').get(skill.id) as { version: number };
      const version = latest.version + 1;
      const id = this.ids.id();
      const manifest = {
        ...parsedSkill.manifest,
        stableKey: parsed.stableKey,
        contentHash: parsedSkill.contentHash,
      };
      this.database.prepare(`
        INSERT INTO skill_versions(
          id, skill_id, version, lifecycle, skill_markdown, manifest_json, content_hash,
          proposed_by_user_id, proposed_by_activation_id, created_at
        ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        skill.id,
        version,
        parsed.markdown,
        JSON.stringify(manifest),
        parsedSkill.contentHash,
        normalizedActor.type === 'user' ? normalizedActor.userId : null,
        normalizedActor.type === 'activation' ? normalizedActor.activationId : null,
        now,
      );
      this.recordAudit(projectId, normalizedActor.type === 'user' ? { type: 'user', id: normalizedActor.userId } : { type: 'system' }, 'skill.propose', 'skill_version', id);
      return this.getVersion(id)!;
    })();
  }

  listSkills(projectId: string | null, userId: string): Skill[] {
    if (projectId) this.assertProjectAccess(projectId, userId);
    else this.assertUser(userId);
    return (this.database.prepare('SELECT * FROM skills WHERE project_id IS ? ORDER BY stable_key').all(projectId) as SkillRow[]).map(skillFromRow);
  }

  getSkill(skillId: string, userId?: string): Skill | undefined {
    const row = this.database.prepare('SELECT * FROM skills WHERE id = ?').get(skillId) as SkillRow | undefined;
    if (!row) return undefined;
    if (userId) {
      if (row.project_id) this.assertProjectAccess(row.project_id, userId);
      else this.assertUser(userId);
    }
    return skillFromRow(row);
  }

  findSkill(projectId: string | null, stableKey: string, userId?: string): Skill | undefined {
    if (userId) {
      if (projectId) this.assertProjectAccess(projectId, userId);
      else this.assertUser(userId);
    }
    const row = this.database.prepare('SELECT * FROM skills WHERE project_id IS ? AND stable_key = ?').get(projectId, stableKey) as SkillRow | undefined;
    return row ? skillFromRow(row) : undefined;
  }

  listVersions(skillId: string, userId?: string): SkillVersion[] {
    this.getSkillOrThrow(skillId, userId);
    return (this.database.prepare('SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY version DESC').all(skillId) as VersionRow[]).map(versionFromRow);
  }

  getVersion(versionId: string, userId?: string): SkillVersion | undefined {
    const row = this.database.prepare('SELECT * FROM skill_versions WHERE id = ?').get(versionId) as VersionRow | undefined;
    if (!row) return undefined;
    this.getSkillOrThrow(row.skill_id, userId);
    return versionFromRow(row);
  }

  activate(versionId: string, userId: string): SkillVersion {
    return this.changeLifecycle(versionId, 'active', userId);
  }

  deprecate(versionId: string, userId: string): SkillVersion {
    return this.changeLifecycle(versionId, 'deprecated', userId);
  }

  setLifecycle(versionId: string, lifecycle: SkillLifecycle, userId: string): SkillVersion {
    const parsed = SkillLifecycleInputSchema.parse({ lifecycle });
    return this.changeLifecycle(versionId, parsed.lifecycle, userId);
  }

  private changeLifecycle(versionId: string, lifecycle: SkillLifecycle, userId: string): SkillVersion {
    const row = this.database.prepare('SELECT * FROM skill_versions WHERE id = ?').get(versionId) as VersionRow | undefined;
    if (!row) throw new Error('Skill version not found');
    const skill = this.getSkillOrThrow(row.skill_id, userId);
    if (!skill.projectId) this.assertAdministrator(userId);
    if (lifecycle === 'active' || lifecycle === 'deprecated') {
      // A proposal records its origin, but only a human user can activate/deprecate it.
      this.assertUser(userId);
    }
    if (row.lifecycle === 'deprecated' && lifecycle !== 'deprecated') throw new Error('Deprecated skill versions cannot be reused');
    if (row.lifecycle === lifecycle && (lifecycle !== 'active' || skill.activeVersionId === versionId)) return versionFromRow(row);
    const tx = this.database.transaction(() => {
      if (lifecycle === 'active') {
        this.database.prepare("UPDATE skill_versions SET lifecycle = 'deprecated' WHERE skill_id = ? AND lifecycle = 'active' AND id <> ?").run(row.skill_id, versionId);
        const updated = this.database.prepare("UPDATE skill_versions SET lifecycle = 'active' WHERE id = ? AND lifecycle <> 'deprecated'").run(versionId);
        if (updated.changes !== 1) throw new Error('Deprecated skill versions cannot be activated');
        this.database.prepare('UPDATE skills SET active_version_id = ? WHERE id = ?').run(versionId, row.skill_id);
      } else if (lifecycle === 'deprecated') {
        this.database.prepare("UPDATE skill_versions SET lifecycle = 'deprecated' WHERE id = ?").run(versionId);
        this.database.prepare('UPDATE skills SET active_version_id = NULL WHERE id = ? AND active_version_id = ?').run(row.skill_id, versionId);
      } else {
        if (row.lifecycle === 'active') throw new Error('Active skill versions must be deprecated before changing lifecycle');
        this.database.prepare('UPDATE skill_versions SET lifecycle = ? WHERE id = ?').run(lifecycle, versionId);
      }
      this.recordAudit(skill.projectId ?? null, { type: 'user', id: userId }, 'skill.lifecycle', 'skill_version', versionId, { lifecycle });
    });
    tx();
    return this.getVersion(versionId, userId)!;
  }

  private getSkillOrThrow(skillId: string, userId?: string): Skill {
    const skill = this.getSkill(skillId, userId);
    if (!skill) throw new Error('Skill not found');
    return skill;
  }

  private assertUser(userId: string): void {
    const row = this.database.prepare('SELECT 1 AS ok FROM users WHERE id = ? AND disabled_at IS NULL').get(userId) as { ok: number } | undefined;
    if (!row) throw new SkillAuthorizationError();
  }

  private assertAdministrator(userId: string): void {
    const row = this.database.prepare(`
      SELECT 1 AS ok FROM team_members tm
      JOIN users u ON u.id = tm.user_id
      WHERE tm.user_id = ? AND tm.role = 'administrator' AND u.disabled_at IS NULL
    `).get(userId) as { ok: number } | undefined;
    if (!row) throw new SkillAuthorizationError('Administrator access is required for installation-global skills');
  }

  private assertProjectAccess(projectId: string, userId: string): void {
    const row = this.database.prepare(`
      SELECT 1 AS ok FROM projects p JOIN team_members tm ON tm.team_id = p.team_id
      JOIN users u ON u.id = tm.user_id
      WHERE p.id = ? AND u.id = ? AND u.disabled_at IS NULL
    `).get(projectId, userId) as { ok: number } | undefined;
    if (!row) throw new SkillAuthorizationError();
  }

  private assertActivationAccess(projectId: string, activationId: string): void {
    const row = this.database.prepare(`
      SELECT 1 AS ok FROM agent_activations aa
      JOIN logical_agents la ON la.id = aa.logical_agent_id
      JOIN runs r ON r.id = la.run_id
      JOIN sessions s ON s.id = r.session_id
      WHERE aa.id = ? AND s.project_id = ?
    `).get(activationId, projectId) as { ok: number } | undefined;
    if (!row) throw new SkillAuthorizationError();
  }

  /** Record review and lifecycle actions without persisting skill content in audit details. */
  private recordAudit(projectId: string | null, actor: { type: 'user' | 'system'; id?: string }, action: string, targetType: string, targetId: string, detail?: Record<string, unknown>): void {
    this.database.prepare(`
      INSERT INTO audit_records(id, project_id, actor_type, actor_id, action, target_type, target_id, outcome, detail_json, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'allowed', ?, ?)
    `).run(this.ids.id(), projectId, actor.type, actor.id ?? null, action, targetType, targetId, detail ? JSON.stringify(detail) : '{}', this.clock.now().toISOString());
  }
}

export type SkillReadService = Pick<SkillsService, 'getSkill' | 'findSkill' | 'listSkills' | 'listVersions' | 'getVersion'>;
export type SkillProposalService = Pick<SkillsService, 'propose' | 'activate' | 'deprecate' | 'setLifecycle'>;

function skillFromRow(row: SkillRow): Skill {
  return {
    id: row.id,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    stableKey: row.stable_key,
    name: row.name,
    ...(row.active_version_id ? { activeVersionId: row.active_version_id } : {}),
    createdAt: row.created_at,
  };
}

function versionFromRow(row: VersionRow): SkillVersion {
  let manifest: SkillManifest = { name: '', description: '' };
  try {
    const parsed: unknown = JSON.parse(row.manifest_json);
    const result = SkillManifestSchema.safeParse(parsed);
    if (result.success) manifest = result.data;
  } catch {
    // Keep reads safe when importing a legacy row with malformed metadata.
  }
  return {
    id: row.id,
    skillId: row.skill_id,
    version: row.version,
    lifecycle: row.lifecycle,
    markdown: row.skill_markdown,
    manifest,
    contentHash: row.content_hash,
    ...(row.proposed_by_user_id ? { proposedByUserId: row.proposed_by_user_id } : {}),
    ...(row.proposed_by_activation_id ? { proposedByActivationId: row.proposed_by_activation_id } : {}),
    createdAt: row.created_at,
  };
}

export function skillDigest(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}
