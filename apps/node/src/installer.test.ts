import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installClient, installSkills, planInstallation, type InstallOptions } from './installer.js';
import { runCli } from './cli.js';
const directories: string[] = [];
const defaults: InstallOptions = { client: 'codex', configPath: '/fixture/config.toml', executable: '/fixture/dhole/apps/node/dist/index.js', stateDir: '/fixture/state' };
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('explicit reversible client installation', () => {
  it('preserves Codex settings, replaces only its marker, and reverses its block', () => {
    const original = 'model = "fixture"\n[mcp_servers.existing]\ncommand = "fixture"\n';
    const installed = planInstallation(defaults, original);
    expect(installed).toContain(original);
    expect(planInstallation(defaults, installed)).toBe(installed);
    expect(planInstallation({ ...defaults, uninstall: true }, installed)).toBe(original);
    expect(() => planInstallation(defaults, '[mcp_servers.dhole]\ncommand = "someone-else"\n')).toThrow('unowned_dhole_configuration');
    expect(() => planInstallation(defaults, '# BEGIN DHOLE MANAGED MCP\n')).toThrow('ambiguous_installation_marker');
  });

  it.each(['claude', 'opencode'] as const)('preserves other %s entries and removes only owned setup', (client) => {
    const key = client === 'claude' ? 'mcpServers' : 'mcp';
    const original = { other: true, [key]: { existing: { command: 'fixture' } } };
    const options = { ...defaults, client };
    expect(planInstallation({ ...options, uninstall: true }, JSON.stringify(original))).toBe(JSON.stringify(original));
    const installed = planInstallation(options, JSON.stringify(original));
    expect(JSON.parse(planInstallation({ ...options, uninstall: true }, installed))).toEqual(original);
    expect(planInstallation(options, installed)).toBe(installed);
    expect(() => planInstallation(options, JSON.stringify({ [key]: { dhole: { command: 'someone-else' } } }))).toThrow('unowned_dhole_configuration');
  });

  it('never prints unrelated config secrets in a dry-run preview', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dhole-install-test-'));
    directories.push(root);
    const configPath = join(root, 'config.toml');
    writeFileSync(configPath, 'api_key = "fixture-secret-key"\n');
    let output = '';
    await runCli(['install', '--client', 'codex', '--config', configPath, '--dry-run'], { output: (text) => { output += text; }, executable: '/fixture/dhole/index.js' });
    expect(output).not.toContain('fixture-secret-key');
    expect(output).toContain('mcp_servers.dhole');
    expect(readFileSync(configPath, 'utf8')).toBe('api_key = "fixture-secret-key"\n');
  });

  it('previews without writing and changes only the explicit file when applied', () => {
    const root = mkdtempSync(join(tmpdir(), 'dhole-install-test-'));
    directories.push(root);
    const configPath = join(root, 'config.toml');
    const options = { ...defaults, configPath };
    expect(installClient({ ...options, dryRun: true }).changed).toBe(true);
    expect(existsSync(configPath)).toBe(false);
    writeFileSync(configPath, 'model = "fixture"\n');
    installClient(options);
    expect(readFileSync(configPath, 'utf8')).toContain('mcp_servers.dhole');
    installClient({ ...options, uninstall: true });
    expect(readFileSync(configPath, 'utf8')).toBe('model = "fixture"\n');
  });
});


describe('maintained agent skill installation', () => {
  it('previews, installs repeatedly, and removes only its two owned instruction files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dhole-skills-test-'));
    directories.push(root);
    const skillsDir = join(root, 'skills');
    const coordination = join(skillsDir, 'dhole-coordination', 'SKILL.md');
    const gateway = join(skillsDir, 'dhole-gateway', 'SKILL.md');
    let output = '';
    await runCli(['install-skills', '--skills-dir', skillsDir, '--dry-run'], { output: (text) => { output += text; } });
    expect(output).toContain(coordination);
    expect(existsSync(skillsDir)).toBe(false);
    expect(installSkills({ skillsDir }).every((result) => result.changed)).toBe(true);
    expect(readFileSync(coordination, 'utf8')).toContain('coordination_complete');
    expect(readFileSync(gateway, 'utf8')).toContain('gateway_manage');
    expect(installSkills({ skillsDir }).every((result) => !result.changed)).toBe(true);
    const localNote = join(skillsDir, 'dhole-coordination', 'notes.md');
    writeFileSync(localNote, 'Keep this local note');
    installSkills({ skillsDir, uninstall: true });
    expect(existsSync(coordination)).toBe(false);
    expect(existsSync(gateway)).toBe(false);
    expect(readFileSync(localNote, 'utf8')).toBe('Keep this local note');
    expect(installSkills({ skillsDir, uninstall: true }).every((result) => !result.changed)).toBe(true);
  });

  it('rejects unowned skills and symlinks before modifying either target', () => {
    const root = mkdtempSync(join(tmpdir(), 'dhole-skills-test-'));
    directories.push(root);
    const skillsDir = join(root, 'skills');
    const gateway = join(skillsDir, 'dhole-gateway');
    mkdirSync(gateway, { recursive: true });
    writeFileSync(join(gateway, 'SKILL.md'), 'Local instructions');
    expect(() => installSkills({ skillsDir })).toThrow('unowned_dhole_skill');
    expect(existsSync(join(skillsDir, 'dhole-coordination'))).toBe(false);
    writeFileSync(join(gateway, 'SKILL.md'), '');
    expect(() => installSkills({ skillsDir })).toThrow('unowned_dhole_skill');
    expect(() => installSkills({ skillsDir, uninstall: true })).toThrow('unowned_dhole_skill');
    rmSync(gateway, { recursive: true });
    symlinkSync(root, gateway, 'dir');
    expect(() => installSkills({ skillsDir })).toThrow('skill_target_must_not_be_symlink');
    expect(() => installSkills({ skillsDir: 'relative' })).toThrow('absolute_skills_directory_required');
  });
});
