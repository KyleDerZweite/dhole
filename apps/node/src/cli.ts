import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createNodeClient, type NodeClient } from './client.js';
import { loadNodeConfig } from './config.js';
import { AgentBridge, serveStdio } from './bridge.js';
import { ClientError, connectMachine, createNativeProject } from './onboarding.js';
import { executeGatewayAction, GatewayActionSchema } from './gateway-client.js';
import { installClient, installSkills, planInstallation } from './installer.js';

export const CLI_HELP = `Usage: dhole-node [run] [--state-dir PATH]
       dhole-node connect --server URL [--state-dir PATH] [--agent-only] [--gateway]
                          [--name NAME] [--repository ID=/absolute/path] [--dry-run]
       dhole-node create-project --name NAME [--remote URL] [--state-dir PATH]
                                 [--request-id KEY] [--dry-run]
       dhole-node gateway --project ID --action JSON [--state-dir PATH] [--dry-run]
       dhole-node mcp [--state-dir PATH] [--project PROJECT_ID] [--agent NAME]
       dhole-node install|uninstall --client codex|claude|opencode --config PATH
                                   [--state-dir PATH] [--project ID] [--dry-run]
       dhole-node install-skills|uninstall-skills --skills-dir PATH [--dry-run]

connect opens no service. Approve its code in the central server's browser UI.
Only explicitly listed repository roots enter the node's local allowlist.
The MCP process selects an authorized project from the current Git push remote;
--project explicitly selects manual project mode. It handles auth and heartbeat.
install previews with --dry-run; it only edits the explicitly named config file.
install-skills copies maintained Coordination and Gateway skills to the explicit directory.
--help is side-effect free. No credentials are printed.
`;

export async function runCli(args: string[] = process.argv.slice(2), options: { output?: (text: string) => void; error?: (text: string) => void; environment?: NodeJS.ProcessEnv; executable?: string } = {}): Promise<NodeClient | undefined> {
  const output = options.output ?? ((text: string) => process.stdout.write(text));
  const error = options.error ?? ((text: string) => process.stderr.write(text));
  const environment = options.environment ?? process.env;
  const parsed = parseArgs({ args, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, 'skills-dir': { type: 'string' }, server: { type: 'string' }, 'state-dir': { type: 'string' }, name: { type: 'string' },
    repository: { type: 'string', multiple: true }, 'agent-only': { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    gateway: { type: 'boolean' }, action: { type: 'string' }, remote: { type: 'string' }, 'request-id': { type: 'string' }, client: { type: 'string' }, config: { type: 'string' }, project: { type: 'string' }, agent: { type: 'string' },
  } });
  if (parsed.values.help) { output(CLI_HELP); return undefined; }
  const command = parsed.positionals[0] ?? 'run';
  if (parsed.positionals.length > 1) throw new ClientError('unexpected_positional_argument');
  const stateDir = resolve(parsed.values['state-dir'] ?? environment.DHOLE_NODE_STATE_DIR ?? join(homedir(), '.dhole-node'));
  if (command === 'connect') {
    if (!parsed.values.server) throw new ClientError('server_required');
    const repositories: Record<string, string> = {};
    for (const value of parsed.values.repository ?? []) {
      const separator = value.indexOf('=');
      if (separator < 1 || !isAbsolute(value.slice(separator + 1))) throw new ClientError('repository_requires_id_and_absolute_path');
      const id = value.slice(0, separator);
      if (Object.hasOwn(repositories, id)) throw new ClientError('duplicate_repository_id');
      repositories[id] = value.slice(separator + 1);
    }
    const controller = new AbortController();
    const abort = () => { controller.abort(); };
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    try {
      await connectMachine({ server: parsed.values.server, stateDir, repositories, signal: controller.signal,
        ...(parsed.values.name ? { machineName: parsed.values.name } : {}),
        ...(parsed.values['agent-only'] ? { agentOnly: true } : {}), ...(parsed.values.gateway ? { gateway: true } : {}), ...(parsed.values['dry-run'] ? { dryRun: true } : {}),
      }, { output: (line) => output(`${line}\n`) });
    } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
    return undefined;
  }
  if (command === 'create-project') {
    if (!parsed.values.name) throw new ClientError('project_name_required');
    await createNativeProject({ stateDir, name: parsed.values.name,
      ...(parsed.values.remote ? { remote: parsed.values.remote } : {}),
      ...(parsed.values['request-id'] ? { requestId: parsed.values['request-id'] } : {}),
      dryRun: parsed.values['dry-run'] ?? false,
    }, { output: (line) => output(`${line}\n`) });
    return undefined;
  }
  if (command === 'gateway') {
    if (!parsed.values.project || !parsed.values.action) throw new ClientError('gateway_project_and_action_required');
    const action = GatewayActionSchema.parse(JSON.parse(parsed.values.action) as unknown);
    if (parsed.values['dry-run']) { output('Would perform the selected Gateway action in the explicit project. No changes made.\n'); return undefined; }
    const result = await executeGatewayAction(action, { stateDir, projectId: parsed.values.project });
    output(`${JSON.stringify(result)}\n`);
    return undefined;
  }
  if (command === 'mcp') {
    if (parsed.values['dry-run']) { output('Would start the stdio coordination bridge. No changes made.\n'); return undefined; }
    const bridge = new AgentBridge({ stateDir, cwd: process.cwd(), ...(parsed.values.project ? { projectId: parsed.values.project } : {}),
      ...(parsed.values.agent ? { agentLabel: parsed.values.agent } : {}), warning: (line) => error(`${line}\n`) });
    await serveStdio(bridge);
    return undefined;
  }
  if (command === 'install-skills' || command === 'uninstall-skills') {
    if (!parsed.values['skills-dir']) throw new ClientError('absolute_skills_directory_required');
    const results = installSkills({ skillsDir: parsed.values['skills-dir'], uninstall: command === 'uninstall-skills', dryRun: parsed.values['dry-run'] ?? false });
    for (const result of results) output(`${result.dryRun ? 'Would update' : result.changed ? 'Updated' : 'Already configured'} ${result.path}\n`);
    return undefined;
  }
  if (command === 'install' || command === 'uninstall') {
    const client = z.enum(['codex', 'claude', 'opencode']).parse(parsed.values.client);
    if (!parsed.values.config || !isAbsolute(parsed.values.config)) throw new ClientError('absolute_config_path_required');
    const executable = options.executable ?? process.argv[1];
    if (!executable) throw new ClientError('executable_path_required');
    const result = installClient({ client, configPath: parsed.values.config, executable: resolve(executable), stateDir,
      uninstall: command === 'uninstall', dryRun: parsed.values['dry-run'] ?? false, ...(parsed.values.project ? { projectId: parsed.values.project } : {}) });
    output(`${result.dryRun ? 'Would update' : result.changed ? 'Updated' : 'Already configured'} ${result.path}\n`);
    if (result.dryRun) {
      if (command === 'uninstall') output('Would remove only the owned Dhole MCP entry.\n');
      else output(planInstallation({ client, configPath: parsed.values.config, executable: resolve(executable), stateDir, ...(parsed.values.project ? { projectId: parsed.values.project } : {}) }, ''));
    }
    return undefined;
  }
  if (command !== 'run') throw new ClientError('unknown_command');
  if (parsed.values['dry-run']) { output('Would start the outbound node. No changes made.\n'); return undefined; }
  const client = createNodeClient({ config: loadNodeConfig({ ...environment, DHOLE_NODE_STATE_DIR: stateDir }) });
  const stop = () => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); void client.stop(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  client.start();
  return client;
}
