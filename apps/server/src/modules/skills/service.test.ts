import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { secureIds, systemClock } from '../../lib/clock.js';
import { openDatabase } from '../../lib/database.js';
import { EventStore } from '../../lib/events.js';
import { HttpError } from '../../lib/http.js';
import type { AppEnvironment, ServerContext } from '../../lib/module.js';
import { skillsModule } from './index.js';
import { parseSkillMarkdown, validateSkillDirectory, validateSkillReference } from './parser.js';
import { SkillAuthorizationError, SkillsService } from './service.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(): { skills: SkillsService; close: () => void; userId: string; memberId: string; outsiderId: string; projectId: string; database: ReturnType<typeof openDatabase> } {
  const directory = mkdtempSync(join(tmpdir(), 'dhole-skills-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'dhole.db'), systemClock);
  const userId = 'user-skills';
  const memberId = 'member-skills';
  const outsiderId = 'outsider-skills';
  const projectId = 'project-skills';
  database.prepare('INSERT INTO teams(id, name, created_at) VALUES (?, ?, ?)').run('team-skills', 'Skills', '2026-08-30T00:00:00.000Z');
  database.prepare('INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(userId, 'skills@example.test', 'Skills', 'not-used', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
  database.prepare('INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(memberId, 'member@example.test', 'Member', 'not-used', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
  database.prepare('INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(outsiderId, 'outsider@example.test', 'Outsider', 'not-used', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
  database.prepare('INSERT INTO team_members(team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run('team-skills', userId, 'administrator', '2026-08-30T00:00:00.000Z');
  database.prepare('INSERT INTO team_members(team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run('team-skills', memberId, 'member', '2026-08-30T00:00:00.000Z');
  database.prepare('INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(projectId, 'team-skills', 'Skills', userId, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
  return { skills: new SkillsService(database), close: () => database.close(), userId, memberId, outsiderId, projectId, database };
}

const markdown = `---
name: local-review
description: Review a local change
license: MIT
allowed-tools: Read, Grep
references: references/checklist.md
---

Review the supplied diff and report actionable findings.`;

describe('portable Agent Skills', () => {
  it('parses required frontmatter and rejects traversal', () => {
    const parsed = parseSkillMarkdown(markdown, { directory: 'skills/local-review' });
    expect(parsed.manifest.name).toBe('local-review');
    expect(parsed.manifest.allowedTools).toEqual(['Read', 'Grep']);
    expect(parsed.manifest.references).toEqual(['references/checklist.md']);
    expect(() => parseSkillMarkdown(markdown, { directory: '../local-review' })).toThrow(/traversal/);
    expect(() => validateSkillDirectory('skills/other', 'local-review')).toThrow(/match/);
    expect(() => validateSkillReference('../secret')).toThrow(/traversal/);
  });

  it('keeps agent proposals in draft until a human activates them', () => {
    const f = fixture();
    const version = f.skills.propose({ projectId: f.projectId, stableKey: 'local-review', markdown, directory: 'local-review' }, f.userId);
    expect(version.lifecycle).toBe('draft');
    expect(f.skills.getSkill(version.skillId, f.userId)?.activeVersionId).toBeUndefined();
    const active = f.skills.activate(version.id, f.userId);
    expect(active.lifecycle).toBe('active');
    expect(f.skills.getSkill(version.skillId, f.userId)?.activeVersionId).toBe(version.id);
    const next = f.skills.propose({ projectId: f.projectId, stableKey: 'local-review', markdown: markdown.replace('Review a local change', 'Review a change carefully'), directory: 'local-review' }, f.userId);
    expect(() => f.skills.activate(next.id, f.userId)).not.toThrow();
    expect(f.skills.getVersion(version.id, f.userId)?.lifecycle).toBe('deprecated');
    f.close();
  });

  it('allows global reads to members but reserves global mutation for administrators', () => {
    const f = fixture();
    const global = f.skills.propose({ stableKey: 'local-review', markdown, directory: 'local-review' }, f.userId);
    expect(f.skills.getVersion(global.id, f.memberId)?.id).toBe(global.id);
    expect(() => f.skills.propose({ stableKey: 'global-other', markdown: markdown.replace('local-review', 'global-other'), directory: 'global-other' }, f.memberId)).toThrow(/Administrator/);
    expect(() => f.skills.activate(global.id, f.memberId)).toThrow(/Administrator/);
    expect(() => f.skills.deprecate(global.id, f.memberId)).toThrow(/Administrator/);
    expect(f.skills.activate(global.id, f.userId).lifecycle).toBe('active');
    const project = f.skills.propose({ projectId: f.projectId, stableKey: 'project-review', markdown: markdown.replaceAll('local-review', 'project-review'), directory: 'project-review' }, f.userId);
    expect(f.skills.getVersion(project.id, f.memberId)?.id).toBe(project.id);
    expect(f.skills.activate(project.id, f.memberId).lifecycle).toBe('active');
    f.close();
  });

  it('audits proposals and lifecycle changes, rolling back a failed proposal audit', () => {
    const f = fixture();
    const version = f.skills.propose({ projectId: f.projectId, stableKey: 'audited-skill', markdown: markdown.replaceAll('local-review', 'audited-skill'), directory: 'audited-skill' }, f.userId);
    expect(f.database.prepare("SELECT actor_type, actor_id, action, target_type, target_id, detail_json FROM audit_records WHERE action = 'skill.propose'").get()).toMatchObject({
      actor_type: 'user', actor_id: f.userId, action: 'skill.propose', target_type: 'skill_version', target_id: version.id, detail_json: '{}',
    });
    f.skills.activate(version.id, f.userId);
    expect(f.database.prepare("SELECT actor_type, actor_id, action, target_type, target_id, detail_json FROM audit_records WHERE action = 'skill.lifecycle'").get()).toMatchObject({
      actor_type: 'user', actor_id: f.userId, action: 'skill.lifecycle', target_type: 'skill_version', target_id: version.id, detail_json: '{"lifecycle":"active"}',
    });

    f.database.exec(`CREATE TRIGGER fail_skill_audit BEFORE INSERT ON audit_records
      WHEN NEW.action = 'skill.propose' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
    const markdownRollback = markdown.replaceAll('local-review', 'rollback-skill');
    expect(() => f.skills.propose({ projectId: f.projectId, stableKey: 'rollback-skill', markdown: markdownRollback, directory: 'rollback-skill' }, f.userId)).toThrow('audit unavailable');
    expect(f.database.prepare("SELECT count(*) AS count FROM skills WHERE stable_key = 'rollback-skill'").get()).toEqual({ count: 0 });
    expect(f.database.prepare("SELECT count(*) AS count FROM skill_versions WHERE skill_markdown LIKE '%rollback-skill%'").get()).toEqual({ count: 0 });
    f.close();
  });

  it('rejects credential-bearing markdown before persistence', () => {
    const f = fixture();
    expect(() => f.skills.propose({
      projectId: f.projectId,
      stableKey: 'unsafe-skill',
      markdown: '---\nname: unsafe-skill\ndescription: unsafe\n---\napi_key=super-secret-value',
    }, f.userId)).toThrow('must not contain credentials');
    expect(f.database.prepare("SELECT count(*) AS count FROM skills WHERE stable_key = 'unsafe-skill'").get()).toEqual({ count: 0 });
    f.close();
  });

  it('returns a typed 403 for cross-project service and route access', async () => {
    const f = fixture();
    const projectSkill = f.skills.propose({ projectId: f.projectId, stableKey: 'private-review', markdown: markdown.replaceAll('local-review', 'private-review'), directory: 'private-review' }, f.userId);
    expect(() => f.skills.getVersion(projectSkill.id, f.outsiderId)).toThrow(SkillAuthorizationError);
    try {
      f.skills.getVersion(projectSkill.id, f.outsiderId);
    } catch (error) {
      expect(error).toMatchObject({ status: 403, statusCode: 403, code: 'skill_authorization_denied' });
    }

    const context: ServerContext = {
      config: { environment: 'test' } as ServerContext['config'],
      database: f.database,
      clock: systemClock,
      ids: secureIds,
      events: new EventStore(f.database, systemClock, secureIds),
    };
    const app = new Hono<AppEnvironment>();
    app.use('*', (c, next) => {
      c.set('user', { id: f.outsiderId, email: 'outsider@example.test', displayName: 'Outsider', role: 'member', teamId: 'other-team' });
      return next();
    });
    skillsModule.register(app, context);
    app.onError((error, c) => error instanceof HttpError ? c.json({ error: { code: error.code } }, error.status) : c.json({ error: { code: 'internal_error' } }, 500));
    const response = await app.request(`/api/skills/versions/${projectSkill.id}`);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: 'skill_authorization_denied' } });
    f.close();
  });
});
