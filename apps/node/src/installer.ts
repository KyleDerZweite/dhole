import { existsSync, readFileSync, statSync, lstatSync, mkdirSync, readdirSync, rmdirSync, chmodSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ClientError } from './onboarding.js';

const START = '# BEGIN DHOLE MANAGED MCP';
const END = '# END DHOLE MANAGED MCP';
const OWNER = 'dhole-managed';
const JsonConfigSchema = z.record(z.string(), z.unknown());
export interface InstallOptions {
  client: 'codex' | 'claude' | 'opencode'; configPath: string; executable: string; stateDir: string;
  uninstall?: boolean; dryRun?: boolean; projectId?: string;
}

/** Explicit target file only. A marker prevents overwriting another MCP entry. */
export function planInstallation(options: InstallOptions, current = ''): string {
  for (const path of [options.configPath, options.executable, options.stateDir]) if (!isAbsolute(path)) throw new ClientError('installation_paths_must_be_absolute');
  const args = [options.executable, 'mcp', '--state-dir', options.stateDir];
  if (options.projectId) args.push('--project', z.string().min(1).max(160).parse(options.projectId));
  if (options.client === 'codex') {
    const starts = current.split(START).length - 1;
    const ends = current.split(END).length - 1;
    if (starts !== ends || starts > 1) throw new ClientError('ambiguous_installation_marker');
    const start = current.indexOf(START);
    const end = current.indexOf(END);
    if (start !== -1 && end < start) throw new ClientError('ambiguous_installation_marker');
    let next = start === -1 ? current : current.slice(0, start) + current.slice(end + END.length).replace(/^\r?\n/u, '');
    if (options.uninstall) return next;
    if (/^\s*\[mcp_servers\.(?:dhole|"dhole"|'dhole')(?:\]|\.)/mu.test(next)) throw new ClientError('unowned_dhole_configuration');
    next = `${next}${next && !next.endsWith('\n') ? '\n' : ''}`;
    return `${next}${START}\n[mcp_servers.dhole]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(args)}\n${END}\n`;
  }
  let root: z.infer<typeof JsonConfigSchema>;
  try { root = JsonConfigSchema.parse(current.trim() ? JSON.parse(current) as unknown : {}); }
  catch { throw new ClientError('config_must_be_valid_json'); }
  const key = options.client === 'opencode' ? 'mcp' : 'mcpServers';
  const entries = JsonConfigSchema.parse(root[key] ?? {});
  const existing = entries.dhole;
  if (options.uninstall && existing === undefined) return current;
  if (existing !== undefined) {
    const parsed = z.object({ env: z.record(z.string(), z.string()).optional(), environment: z.record(z.string(), z.string()).optional() }).safeParse(existing);
    if (!parsed.success || (parsed.data.env?.DHOLE_CONFIG_OWNER ?? parsed.data.environment?.DHOLE_CONFIG_OWNER) !== OWNER) throw new ClientError('unowned_dhole_configuration');
  }
  if (options.uninstall) delete entries.dhole;
  else entries.dhole = options.client === 'opencode'
    ? { type: 'local', command: [process.execPath, ...args], environment: { DHOLE_CONFIG_OWNER: OWNER }, enabled: true }
    : { command: process.execPath, args, env: { DHOLE_CONFIG_OWNER: OWNER } };
  if (Object.keys(entries).length > 0 || root[key] !== undefined) root[key] = entries;
  return `${JSON.stringify(root, null, 2)}\n`;
}

export function installClient(options: InstallOptions): { path: string; content: string; changed: boolean; dryRun: boolean } {
  const path = resolve(options.configPath);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const content = planInstallation(options, current);
  const changed = current !== content;
  if (!options.dryRun && changed) {
    if (!existsSync(dirname(path))) throw new ClientError('config_parent_directory_missing');
    const temporary = `${path}.${randomUUID()}.tmp`;
    const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
    writeFileSync(temporary, content, { flag: 'wx', mode });
    try { chmodSync(temporary, mode); renameSync(temporary, path); }
    catch (error) { unlinkSync(temporary); throw error; }
  }
  return { path, content, changed, dryRun: options.dryRun ?? false };
}


const SKILL_NAMES = ['dhole-coordination', 'dhole-gateway'] as const;

/** Agent instructions have their own explicit target, separate from MCP config. */
export function installSkills(options: { skillsDir: string; uninstall?: boolean; dryRun?: boolean }): Array<{ path: string; changed: boolean; dryRun: boolean }> {
  if (!isAbsolute(options.skillsDir)) throw new ClientError('absolute_skills_directory_required');
  const plans = SKILL_NAMES.map((name) => {
    const directory = join(options.skillsDir, name);
    const path = join(directory, 'SKILL.md');
    if ((existsSync(directory) && lstatSync(directory).isSymbolicLink()) || (existsSync(path) && lstatSync(path).isSymbolicLink())) throw new ClientError('skill_target_must_not_be_symlink');
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (existsSync(path) && !current.includes(`<!-- DHOLE MANAGED SKILL: ${name} -->`)) throw new ClientError('unowned_dhole_skill');
    const content = options.uninstall ? '' : readFileSync(new URL(`../../../clients/skills/${name}/SKILL.md`, import.meta.url), 'utf8');
    return { directory, path, content, changed: current !== content, dryRun: options.dryRun ?? false };
  });
  for (const plan of plans) {
    if (!plan.changed || plan.dryRun) continue;
    if (options.uninstall) {
      unlinkSync(plan.path);
      if (readdirSync(plan.directory).length === 0) rmdirSync(plan.directory);
    } else {
      mkdirSync(plan.directory, { recursive: true });
      const temporary = `${plan.path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, plan.content, { flag: 'wx', mode: 0o644 });
      try { renameSync(temporary, plan.path); }
      catch (error) { unlinkSync(temporary); throw error; }
    }
  }
  return plans.map(({ path, changed, dryRun }) => ({ path, changed, dryRun }));
}
