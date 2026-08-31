import { createHash } from 'node:crypto';
import type { EventKind, NodeCommand } from '@dhole-control/shared';
import { HttpError } from '../../lib/http.js';
import type { ServerContext } from '../../lib/module.js';
import { redactSecrets, redactText } from '../../lib/security.js';
import { BlockingOverlapError } from '../coordination/index.js';
import { recordAudit } from '../core/index.js';
import {
  ChildWorkItemInputSchema,
  CreateProfileInputSchema,
  CreateProfileVersionInputSchema,
  OrchestrationProfileConfigSchema,
  type ChildWorkItemInput,
  type CoordinationApi,
  type CoordinationClaimResult,
  type CoordinationClaimInput,
  type FleetApi,
  type MachineCapability,
  type OrchestrationProfileConfig,
  type SchedulerOptions,
  type StartOrchestrationInput,
  StartOrchestrationInputSchema,
  type WorkItemView,
} from './types.js';

export interface OrchestrationServiceOptions extends SchedulerOptions {
  coordination?: CoordinationApi;
  fleet?: FleetApi;
}

export interface ExecutionView {
  id: string;
  projectId: string;
  runId: string;
  profileVersionId: string;
  state: string;
  maxConcurrency: number;
  activeCount: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  workItems: WorkItemView[];
  result?: Record<string, unknown>;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

interface ProfileRow {
  id: string;
  project_id: string;
  stable_key: string;
  name: string;
  active_version: number | null;
  created_at: string;
}

interface ProfileVersionRow {
  id: string;
  profile_id: string;
  version: number;
  config_json: string;
  content_hash: string;
  lifecycle: 'draft' | 'active' | 'deprecated';
  created_by: string;
  created_at: string;
}

interface ExecutionRow {
  id: string;
  run_id: string;
  session_id: string;
  profile_version_id: string;
  state: string;
  max_concurrency: number;
  active_count: number;
  scheduler_lease_owner: string | null;
  scheduler_lease_expires_at: string | null;
  pause_requested_at: string | null;
  cancel_requested_at: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
  project_id: string;
  root_objective: string;
}

interface WorkRow {
  id: string;
  execution_id: string;
  parent_work_item_id: string | null;
  objective: string;
  deliverables_json: string;
  acceptance_json: string;
  required_capabilities_json: string;
  claim_scope_json: string;
  workspace_policy: string;
  budget_json: string;
  depth: number;
  ordinal: number;
  attempt: number;
  state: string;
  result_json: string | null;
  error_summary: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
  machine_id: string | null;
  claim_id: string | null;
}

interface MachineRow {
  machine_id: string;
  machine_name: string;
  machine_status: string;
  available_slots: number;
  runtime_id: string | null;
  runtime_kind: string | null;
  runtime_label: string | null;
  runtime_available: number | null;
  capabilities_json: string | null;
}

const TERMINAL_STATES = new Set(['settled', 'failed', 'cancelled']);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseJson(value: string | null | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}

const OUTBOUND_SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/giu,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/gu,
  /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization|private[_-]?key)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/giu,
];

function redactOutboundText(input: string, maxLength = 200_000): string {
  let output = input.slice(0, maxLength);
  output = output.replace(OUTBOUND_SECRET_PATTERNS[0]!, '[REDACTED_PRIVATE_KEY]');
  output = output.replace(OUTBOUND_SECRET_PATTERNS[1]!, '[REDACTED]');
  output = output.replace(OUTBOUND_SECRET_PATTERNS[2]!, '[REDACTED]');
  output = output.replace(OUTBOUND_SECRET_PATTERNS[3]!, '$1[REDACTED]');
  return output;
}

const MEMORY_URL_CREDENTIALS = /[a-z][a-z\d+.-]*:\/\/[^\s/@]+(?::[^\s/@]*)?@/iu;

function containsProposalCredential(value: string): boolean {
  return redactSecrets(value, value.length) !== value || MEMORY_URL_CREDENTIALS.test(value);
}

interface BudgetValues {
  maxTokens?: number;
  maxCostMicrousd?: number;
}

interface BudgetUsage {
  tokens: number;
  costMicrousd: number;
}

function budgetInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseBudget(value: unknown): BudgetValues {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const candidate = value as Record<string, unknown>;
  const maxTokens = budgetInteger(candidate.maxTokens);
  const maxCostMicrousd = budgetInteger(candidate.maxCostMicrousd);
  return {
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(maxCostMicrousd !== undefined ? { maxCostMicrousd } : {}),
  };
}

function validateBudget(value: Record<string, unknown>): BudgetValues {
  for (const key of ['maxTokens', 'maxCostMicrousd'] as const) {
    if (value[key] !== undefined && budgetInteger(value[key]) === undefined) throw new Error('Invalid orchestration budget');
  }
  return parseBudget(value);
}

function resultUsage(value: unknown): BudgetUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const root = value as Record<string, unknown>;
  const candidates: unknown[] = [root.usage];
  if (root.result && typeof root.result === 'object' && !Array.isArray(root.result)) candidates.push((root.result as Record<string, unknown>).usage);
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const usage = candidate as Record<string, unknown>;
    const tokenFields = [usage.totalTokens, usage.total_tokens, usage.inputTokens, usage.input_tokens, usage.outputTokens, usage.output_tokens].filter((value) => value !== undefined);
    if (tokenFields.some((value) => budgetInteger(value) === undefined)) continue;
    const costFields = [usage.costMicrousd, usage.cost_microusd, usage.estimatedCostMicrousd, usage.estimated_cost_microusd].filter((value) => value !== undefined);
    if (costFields.some((value) => budgetInteger(value) === undefined)) continue;
    const totalTokens = budgetInteger(usage.totalTokens) ?? budgetInteger(usage.total_tokens);
    const inputTokens = budgetInteger(usage.inputTokens) ?? budgetInteger(usage.input_tokens) ?? 0;
    const outputTokens = budgetInteger(usage.outputTokens) ?? budgetInteger(usage.output_tokens) ?? 0;
    const tokens = totalTokens ?? (inputTokens + outputTokens);
    const costMicrousd = budgetInteger(usage.costMicrousd)
      ?? budgetInteger(usage.cost_microusd)
      ?? budgetInteger(usage.estimatedCostMicrousd)
      ?? budgetInteger(usage.estimated_cost_microusd);
    const hasTokenUsage = tokenFields.length > 0;
    if (hasTokenUsage || costMicrousd !== undefined) return { tokens, costMicrousd: costMicrousd ?? 0 };
  }
  return undefined;
}

const SENSITIVE_RESULT_KEY = /(?:authorization|cookie|credential|private[-_]?key|api[-_]?key|secret|password|token)/iu;
const MAX_RESULT_DEPTH = 8;
const MAX_RESULT_ITEMS = 100;

function redactResultValue(value: unknown, depth = 0): unknown {
  if (depth >= MAX_RESULT_DEPTH) return '[TRUNCATED]';
  if (typeof value === 'string') return redactText(value, 4_096);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, MAX_RESULT_ITEMS).map((item) => redactResultValue(item, depth + 1));
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_RESULT_ITEMS)) {
    output[key.slice(0, 256)] = SENSITIVE_RESULT_KEY.test(key) ? '[REDACTED]' : redactResultValue(item, depth + 1);
  }
  return output;
}

function redactResult(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized = redactResultValue(value);
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized) ? sanitized as Record<string, unknown> : {};
}

export class OrchestrationService {
  readonly schedulerId: string;
  readonly leaseMs: number;
  readonly #coordination: CoordinationApi | undefined;
  readonly #fleet: FleetApi | undefined;
  readonly #maxExecutionsPerTick: number;

  constructor(readonly context: ServerContext, options: OrchestrationServiceOptions = {}) {
    this.schedulerId = options.schedulerId ?? `orchestration-${context.ids.id()}`;
    this.leaseMs = Math.max(1_000, Math.min(options.leaseMs ?? 15_000, 120_000));
    this.#maxExecutionsPerTick = Math.max(1, Math.min(options.maxExecutionsPerTick ?? 100, 1_000));
    this.#coordination = options.coordination;
    this.#fleet = options.fleet;
  }

  private now(): string {
    return this.context.clock.now().toISOString();
  }

  private transaction<T>(fn: () => T): T {
    return this.context.events ? this.context.events.transaction(fn) : this.context.database.transaction(fn)();
  }

  private emit(projectId: string, eventKind: EventKind, aggregateType: string, aggregateId: string, payload: Record<string, unknown>, actorUserId?: string): void {
    this.context.events.append({
      projectId,
      eventKind,
      aggregateType,
      aggregateId,
      actor: actorUserId ? { type: 'user', userId: actorUserId } : { type: 'system' },
      source: { kind: 'platform', adapter: 'orchestration' },
      payload,
    });
  }

  private profileConfig(row: ProfileVersionRow): OrchestrationProfileConfig {
    return OrchestrationProfileConfigSchema.parse(JSON.parse(row.config_json) as unknown);
  }

  private budgetUsage(executionId: string, includePending: boolean): BudgetUsage {
    const usage: BudgetUsage = { tokens: 0, costMicrousd: 0 };
    const rows = this.context.database.prepare('SELECT parent_work_item_id, state, budget_json, result_json FROM orchestration_work_items WHERE execution_id = ?').all(executionId) as Array<{ parent_work_item_id: string | null; state: string; budget_json: string; result_json: string | null }>;
    for (const row of rows) {
      if (includePending && row.parent_work_item_id === null) continue;
      const result = row.result_json ? parseJson(row.result_json) : undefined;
      const measured = resultUsage(result);
      if (measured) {
        usage.tokens = Math.min(Number.MAX_SAFE_INTEGER, usage.tokens + measured.tokens);
        usage.costMicrousd = Math.min(Number.MAX_SAFE_INTEGER, usage.costMicrousd + measured.costMicrousd);
        continue;
      }
      const active = ['claiming', 'scheduled', 'running', 'needs_input', 'reviewing'].includes(row.state);
      const pending = includePending && !TERMINAL_STATES.has(row.state);
      if (active || pending || TERMINAL_STATES.has(row.state)) {
        const declared = parseBudget(parseJson(row.budget_json));
        usage.tokens = Math.min(Number.MAX_SAFE_INTEGER, usage.tokens + (declared.maxTokens ?? 0));
        usage.costMicrousd = Math.min(Number.MAX_SAFE_INTEGER, usage.costMicrousd + (declared.maxCostMicrousd ?? 0));
      }
    }
    return usage;
  }

  private checkBudgetAdmission(execution: ExecutionRow, item: WorkRow, config: OrchestrationProfileConfig): string | undefined {
    const limit = parseBudget(config.limits.budget);
    if (limit.maxTokens === undefined && limit.maxCostMicrousd === undefined) return undefined;
    const declared = parseBudget(parseJson(item.budget_json));
    if (limit.maxTokens !== undefined && declared.maxTokens === undefined) return 'Orchestration budget is undeclared';
    if (limit.maxCostMicrousd !== undefined && declared.maxCostMicrousd === undefined) return 'Orchestration budget is undeclared';
    const consumed = this.budgetUsage(execution.id, false);
    if (limit.maxTokens !== undefined && consumed.tokens + (declared.maxTokens ?? 0) > limit.maxTokens) return 'Orchestration budget exhausted';
    if (limit.maxCostMicrousd !== undefined && consumed.costMicrousd + (declared.maxCostMicrousd ?? 0) > limit.maxCostMicrousd) return 'Orchestration budget exhausted';
    return undefined;
  }

  createProfile(input: unknown): { profile: ProfileRow; version: ProfileVersionRow } {
    const value = CreateProfileInputSchema.parse(input);
    const now = this.now();
    const profileId = this.context.ids.id();
    const versionId = this.context.ids.id();
    const config = OrchestrationProfileConfigSchema.parse(value.config);
    const contentHash = createHash('sha256').update(canonical(config)).digest('hex');
    return this.transaction(() => {
      this.context.database
        .prepare('INSERT INTO orchestration_profiles(id, project_id, stable_key, name, active_version, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(profileId, value.projectId, value.stableKey, value.name, null, now);
      this.context.database
        .prepare('INSERT INTO orchestration_profile_versions(id, profile_id, version, config_json, content_hash, lifecycle, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(versionId, profileId, 1, json(config), contentHash, 'draft', value.createdBy, now);
      recordAudit(this.context, {
        projectId: value.projectId,
        actorType: 'user',
        actorId: value.createdBy,
        action: 'orchestration.profile.create',
        targetType: 'orchestration_profile',
        targetId: profileId,
        outcome: 'allowed',
        detail: { profileId, versionId },
      });
      recordAudit(this.context, {
        projectId: value.projectId,
        actorType: 'user',
        actorId: value.createdBy,
        action: 'orchestration.profile.version.create',
        targetType: 'orchestration_profile_version',
        targetId: versionId,
        outcome: 'allowed',
        detail: { profileId, versionId, version: 1, lifecycle: 'draft' },
      });
      return {
        profile: { id: profileId, project_id: value.projectId, stable_key: value.stableKey, name: value.name, active_version: null, created_at: now },
        version: { id: versionId, profile_id: profileId, version: 1, config_json: json(config), content_hash: contentHash, lifecycle: 'draft', created_by: value.createdBy, created_at: now },
      };
    });
  }

  createProfileVersion(input: unknown): ProfileVersionRow {
    const value = CreateProfileVersionInputSchema.parse(input);
    const config = OrchestrationProfileConfigSchema.parse(value.config);
    const contentHash = createHash('sha256').update(canonical(config)).digest('hex');
    const now = this.now();
    const id = this.context.ids.id();
    return this.transaction(() => {
      const profile = this.context.database.prepare('SELECT id FROM orchestration_profiles WHERE id = ? AND project_id = ?').get(value.profileId, value.projectId) as { id: string } | undefined;
      if (!profile) throw new Error('Unknown orchestration profile');
      const activeVersions = value.lifecycle === 'active'
        ? this.context.database.prepare("SELECT id, version FROM orchestration_profile_versions WHERE profile_id = ? AND lifecycle = 'active'").all(value.profileId) as Array<{ id: string; version: number }>
        : [];
      const row = this.context.database.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS version FROM orchestration_profile_versions WHERE profile_id = ?').get(value.profileId) as { version: number };
      this.context.database
        .prepare('INSERT INTO orchestration_profile_versions(id, profile_id, version, config_json, content_hash, lifecycle, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, value.profileId, row.version, json(config), contentHash, value.lifecycle, value.createdBy, now);
      if (value.lifecycle === 'active') {
        this.context.database.prepare("UPDATE orchestration_profile_versions SET lifecycle = 'deprecated' WHERE profile_id = ? AND id <> ? AND lifecycle = 'active'").run(value.profileId, id);
        this.context.database.prepare('UPDATE orchestration_profiles SET active_version = ? WHERE id = ?').run(row.version, value.profileId);
      }
      recordAudit(this.context, {
        projectId: value.projectId,
        actorType: 'user',
        actorId: value.createdBy,
        action: 'orchestration.profile.version.create',
        targetType: 'orchestration_profile_version',
        targetId: id,
        outcome: 'allowed',
        detail: { profileId: value.profileId, versionId: id, version: row.version, lifecycle: value.lifecycle },
      });
      if (value.lifecycle === 'deprecated') {
        recordAudit(this.context, {
          projectId: value.projectId,
          actorType: 'user',
          actorId: value.createdBy,
          action: 'orchestration.profile.version.deprecate',
          targetType: 'orchestration_profile_version',
          targetId: id,
          outcome: 'allowed',
          detail: { profileId: value.profileId, versionId: id, version: row.version },
        });
      }
      for (const previous of activeVersions) {
        recordAudit(this.context, {
          projectId: value.projectId,
          actorType: 'user',
          actorId: value.createdBy,
          action: 'orchestration.profile.version.deprecate',
          targetType: 'orchestration_profile_version',
          targetId: previous.id,
          outcome: 'allowed',
          detail: { profileId: value.profileId, versionId: previous.id, version: previous.version },
        });
      }
      return { id, profile_id: value.profileId, version: row.version, config_json: json(config), content_hash: contentHash, lifecycle: value.lifecycle, created_by: value.createdBy, created_at: now };
    });
  }

  activateProfileVersion(projectId: string, profileId: string, versionId: string, actorUserId?: string): ProfileVersionRow {
    return this.transaction(() => {
      const version = this.context.database
        .prepare('SELECT v.* FROM orchestration_profile_versions v JOIN orchestration_profiles p ON p.id = v.profile_id WHERE p.id = ? AND p.project_id = ? AND v.id = ?')
        .get(profileId, projectId, versionId) as ProfileVersionRow | undefined;
      if (!version) throw new Error('Unknown orchestration profile version');
      if (version.lifecycle === 'deprecated') throw new Error('Deprecated orchestration profile versions cannot be activated');
      const activeVersions = this.context.database.prepare("SELECT id, version FROM orchestration_profile_versions WHERE profile_id = ? AND lifecycle = 'active' AND id <> ?").all(profileId, versionId) as Array<{ id: string; version: number }>;
      this.context.database.prepare("UPDATE orchestration_profile_versions SET lifecycle = 'deprecated' WHERE profile_id = ? AND id <> ? AND lifecycle = 'active'").run(profileId, versionId);
      this.context.database.prepare("UPDATE orchestration_profile_versions SET lifecycle = 'active' WHERE id = ?").run(versionId);
      this.context.database.prepare('UPDATE orchestration_profiles SET active_version = ? WHERE id = ?').run(version.version, profileId);
      const actor = actorUserId ? { actorType: 'user' as const, actorId: actorUserId } : { actorType: 'system' as const };
      for (const previous of activeVersions) {
        recordAudit(this.context, {
          projectId,
          ...actor,
          action: 'orchestration.profile.version.deprecate',
          targetType: 'orchestration_profile_version',
          targetId: previous.id,
          outcome: 'allowed',
          detail: { profileId, versionId: previous.id, version: previous.version },
        });
      }
      recordAudit(this.context, {
        projectId,
        ...actor,
        action: 'orchestration.profile.version.activate',
        targetType: 'orchestration_profile_version',
        targetId: versionId,
        outcome: 'allowed',
        detail: { profileId, versionId, version: version.version, lifecycle: 'active' },
      });
      return { ...version, lifecycle: 'active' };
    });
  }

  private findProfileVersion(projectId: string, input: StartOrchestrationInput): ProfileVersionRow {
    if (input.profileVersionId) {
      const row = this.context.database
        .prepare('SELECT v.* FROM orchestration_profile_versions v JOIN orchestration_profiles p ON p.id = v.profile_id WHERE p.project_id = ? AND v.id = ?')
        .get(projectId, input.profileVersionId) as ProfileVersionRow | undefined;
      if (!row) throw new Error('Unknown orchestration profile version');
      return row;
    }
    if (!input.profileId) throw new Error('profileVersionId or profileId is required');
    const row = this.context.database
      .prepare('SELECT v.* FROM orchestration_profiles p JOIN orchestration_profile_versions v ON v.profile_id = p.id AND v.version = p.active_version WHERE p.project_id = ? AND p.id = ?')
      .get(projectId, input.profileId) as ProfileVersionRow | undefined;
    if (!row) throw new Error('Profile has no active version');
    return row;
  }

  startExecution(input: unknown): ExecutionView {
    const value = StartOrchestrationInputSchema.parse(input);
    const created = this.transaction(() => this.createExecutionRows(value));
    if (value.autoTick) this.tick(value.projectId);
    return this.getExecution(value.projectId, created.id);
  }

  private createExecutionRows(value: StartOrchestrationInput): { id: string; fake: boolean } {
    const now = this.now();
    const run = this.context.database
      .prepare('SELECT r.id, r.root_objective, r.state, s.id AS session_id FROM runs r JOIN sessions s ON s.id = r.session_id WHERE r.id = ? AND s.project_id = ?')
      .get(value.runId, value.projectId) as { id: string; root_objective: string; state: string; session_id: string } | undefined;
    if (!run) throw new Error('Unknown run for project');
    if (TERMINAL_STATES.has(run.state)) throw new HttpError(409, 'run_terminal', 'Terminal runs are immutable; resume with a new run');
    const version = this.findProfileVersion(value.projectId, value);
    const config = this.profileConfig(version);
    const executionId = this.context.ids.id();
    const maxConcurrency = config.limits.maxConcurrency;
    this.context.database
      .prepare('INSERT INTO orchestration_executions(id, run_id, profile_version_id, state, max_concurrency, active_count, created_at, started_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)')
      .run(executionId, value.runId, version.id, 'running', maxConcurrency, now, now, now);
    this.context.database.prepare("UPDATE runs SET state = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?").run(now, now, value.runId);
    const rootId = this.context.ids.id();
    const objective = run.root_objective;
    this.context.database
      .prepare(`INSERT INTO orchestration_work_items(
        id, execution_id, parent_work_item_id, objective, deliverables_json, acceptance_json,
        required_capabilities_json, claim_scope_json, workspace_policy, budget_json,
        depth, ordinal, attempt, state, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?)`)
      // SQLite's orchestration FSM has no separate waiting_on_children value;
      // a blocked root is the durable representation until all descendants settle.
      .run(rootId, executionId, objective, json([]), json([]), json({}), json({}), config.workspacePolicy, json(config.limits.budget), childCountPlaceholder(config, value), now, now);
    const requestedChildren = value.initialChildren ?? config.initialChildren ?? (config.workerRoles.length || 1);
    const childCount = config.fake ? Math.max(2, requestedChildren) : requestedChildren;
    if (childCount === 0) this.context.database.prepare("UPDATE orchestration_work_items SET state = 'queued' WHERE id = ?").run(rootId);
    for (let index = 0; index < childCount; index += 1) {
      const worker = config.workerRoles[index % Math.max(1, config.workerRoles.length)];
      const role = worker?.role ?? `worker-${index + 1}`;
      const childId = this.context.ids.id();
      const childObjective = `${objective}\n\nWorker role: ${role}`;
      const required = { ...(worker?.requiredCapabilities ?? {}), ...(worker?.runtimeKinds.length ? { $runtimeKinds: worker.runtimeKinds } : {}) };
      this.context.database
        .prepare(`INSERT INTO orchestration_work_items(
          id, execution_id, parent_work_item_id, objective, deliverables_json, acceptance_json,
          required_capabilities_json, claim_scope_json, workspace_policy, budget_json,
          depth, ordinal, attempt, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, 'queued', ?, ?)`)
        .run(childId, executionId, rootId, childObjective, json([]), json([]), json(required), json({ intent: childObjective }), config.workspacePolicy, json(config.limits.budget), index + 1, now, now);
      this.emit(value.projectId, 'child.discovered', 'orchestration_work_item', childId, { executionId, sessionId: run.session_id, parentWorkItemId: rootId, ordinal: index + 1 }, value.actorUserId);
    }
    this.emit(value.projectId, 'run.started', 'run', value.runId, { executionId, sessionId: run.session_id, profileVersionId: version.id }, value.actorUserId);
    return { id: executionId, fake: config.fake };

    function childCountPlaceholder(profileConfig: OrchestrationProfileConfig, start: StartOrchestrationInput): string {
      const requested = start.initialChildren ?? profileConfig.initialChildren ?? (profileConfig.workerRoles.length || 1);
      return profileConfig.fake || requested > 0 ? 'blocked' : 'queued';
    }
  }

  pause(projectId: string, executionId: string, actorUserId?: string): ExecutionView {
    return this.transition(projectId, executionId, 'paused', actorUserId);
  }

  resume(projectId: string, executionId: string, actorUserId?: string): ExecutionView {
    const result = this.transition(projectId, executionId, 'running', actorUserId);
    this.tick(projectId);
    return result;
  }

  cancel(projectId: string, executionId: string, actorUserId?: string): ExecutionView {
    const result = this.transaction(() => {
      this.reconcileLinkedTerminalStates(projectId);
      const execution = this.loadExecution(projectId, executionId);
      if (!execution) throw new Error('Unknown orchestration execution');
      if (TERMINAL_STATES.has(execution.state)) return execution;
      const now = this.now();
      const rows = this.context.database.prepare("SELECT * FROM orchestration_work_items WHERE execution_id = ? AND state NOT IN ('settled', 'failed', 'cancelled')").all(executionId) as WorkRow[];
      for (const row of rows) {
        this.queueRuntimeCancel(execution, row);
        this.queueWorktreeCleanup(execution, row);
        this.context.database.prepare("UPDATE orchestration_work_items SET state = 'cancelled', error_summary = ?, completed_at = ?, updated_at = ? WHERE id = ?").run('Cancelled by director', now, now, row.id);
        this.context.database.prepare("UPDATE worktrees SET state = 'failed', updated_at = ? WHERE work_item_id = ? AND state IN ('requested', 'creating', 'ready', 'in_use')").run(now, row.id);
        if (row.claim_id) this.releaseClaim(row.claim_id, 'orchestration cancelled');
        if (row.machine_id) this.context.database.prepare("UPDATE node_commands SET state = 'cancelled', updated_at = ?, completed_at = COALESCE(completed_at, ?) WHERE machine_id = ? AND operation_key LIKE ? AND kind NOT IN ('cancel', 'remove_worktree') AND state NOT IN ('completed', 'failed', 'cancelled', 'expired', 'uncertain')").run(now, now, row.machine_id, `orchestration:${executionId}:${row.id}:%`);
        this.emit(projectId, 'child.state.changed', 'orchestration_work_item', row.id, { executionId, sessionId: execution.session_id, state: 'cancelled', error: 'Cancelled by director' }, actorUserId);
      }
      this.context.database.prepare("UPDATE orchestration_executions SET state = 'cancelled', cancel_requested_at = ?, active_count = 0, completed_at = ?, updated_at = ? WHERE id = ?").run(now, now, now, executionId);
      this.context.database.prepare("UPDATE runs SET state = 'cancelled', completed_at = ?, updated_at = ? WHERE id = ?").run(now, now, execution.run_id);
      this.emit(projectId, 'run.failed', 'run', execution.run_id, { executionId, sessionId: execution.session_id, cancelled: true }, actorUserId);
      return this.loadExecution(projectId, executionId) as ExecutionRow;
    });
    return this.viewExecution(result);
  }

  private transition(projectId: string, executionId: string, target: 'paused' | 'running', actorUserId?: string): ExecutionView {
    const result = this.transaction(() => {
      this.reconcileLinkedTerminalStates(projectId);
      const execution = this.loadExecution(projectId, executionId);
      if (!execution) throw new Error('Unknown orchestration execution');
      if (target === 'paused' && !['queued', 'running'].includes(execution.state)) return execution;
      if (target === 'running' && execution.state !== 'paused') return execution;
      const now = this.now();
      this.context.database.prepare('UPDATE orchestration_executions SET state = ?, pause_requested_at = ?, scheduler_lease_owner = NULL, scheduler_lease_expires_at = NULL, updated_at = ? WHERE id = ?').run(target, target === 'paused' ? now : null, now, executionId);
      this.context.database.prepare('UPDATE runs SET state = ?, updated_at = ? WHERE id = ?').run(target, now, execution.run_id);
      this.emit(projectId, target === 'paused' ? 'orchestration.paused' : 'orchestration.resumed', 'orchestration_execution', executionId, { sessionId: execution.session_id }, actorUserId);
      return this.loadExecution(projectId, executionId) as ExecutionRow;
    });
    return this.viewExecution(result);
  }

  /** One scheduler tick is safe to call from a timer or a reconnect handler. */
  tick(projectId?: string): { executions: number; scheduled: number; settled: number } {
    let scheduled = 0;
    let settled = 0;
    const executions = this.transaction(() => {
      const now = this.now();
      this.reconcileLinkedTerminalStates(projectId);
      this.recoverExpiredLeasesInternal(now, projectId);
      this.reconcileWorktreeCommandResults(projectId);
      this.reconcileCancelledWorktreeCleanup(projectId);
      const rows = this.context.database
        .prepare(`SELECT e.*, s.project_id, s.id AS session_id, r.root_objective FROM orchestration_executions e
                  JOIN runs r ON r.id = e.run_id JOIN sessions s ON s.id = r.session_id
                  WHERE e.state IN ('queued', 'running') ${projectId ? 'AND s.project_id = ?' : ''}
                  ORDER BY e.created_at LIMIT ?`)
        .all(...(projectId ? [projectId, this.#maxExecutionsPerTick] : [this.#maxExecutionsPerTick])) as ExecutionRow[];
      for (const execution of rows) {
        const acquired = this.context.database.prepare(`UPDATE orchestration_executions
          SET scheduler_lease_owner = ?, scheduler_lease_expires_at = ?, updated_at = ?
          WHERE id = ? AND state = 'running' AND (scheduler_lease_owner IS NULL OR scheduler_lease_owner = ? OR scheduler_lease_expires_at < ?)`)
          .run(this.schedulerId, new Date(this.context.clock.now().getTime() + this.leaseMs).toISOString(), now, execution.id, this.schedulerId, now);
        if (acquired.changes === 0) continue;
        scheduled += this.scheduleExecutionInternal(execution);
        settled += this.reconcileExecutionInternal(execution);
      }
      return rows.length;
    });
    return { executions, scheduled, settled };
  }

  recoverExpiredLeases(projectId?: string): number {
    return this.transaction(() => {
      this.reconcileLinkedTerminalStates(projectId);
      const recovered = this.recoverExpiredLeasesInternal(this.now(), projectId);
      this.reconcileWorktreeCommandResults(projectId);
      this.reconcileCancelledWorktreeCleanup(projectId);
      return recovered;
    });
  }

  /** Stop orchestration when its owning Sessions run/session has already ended. */
  private reconcileLinkedTerminalStates(projectId?: string): number {
    const rows = this.context.database.prepare(`SELECT e.*, s.project_id, s.id AS session_id, s.state AS session_state,
      r.root_objective, r.state AS run_state
      FROM orchestration_executions e
      JOIN runs r ON r.id = e.run_id
      JOIN sessions s ON s.id = r.session_id
      WHERE e.state NOT IN ('settled', 'failed', 'cancelled')
        AND (r.state IN ('settled', 'failed', 'cancelled') OR s.state IN ('failed', 'cancelled', 'closed'))
        ${projectId ? 'AND s.project_id = ?' : ''}
      ORDER BY e.updated_at`).all(...(projectId ? [projectId] : [])) as Array<ExecutionRow & { session_state: string; run_state: string }>;
    for (const execution of rows) {
      const linkedState = TERMINAL_STATES.has(execution.run_state)
        ? execution.run_state as 'settled' | 'failed' | 'cancelled'
        : execution.session_state === 'failed' ? 'failed' : 'cancelled';
      this.terminalizeExecutionItems(execution, linkedState, `Linked ${linkedState} state ended this orchestration`);
      this.finishExecutionInternal(execution, linkedState, { reason: `linked_${linkedState}` }, false);
    }
    return rows.length;
  }

  private recoverExpiredLeasesInternal(now: string, projectId?: string): number {
    const where = projectId
      ? `WHERE e.scheduler_lease_expires_at IS NOT NULL AND e.scheduler_lease_expires_at < ? AND s.project_id = ? AND e.state IN ('queued', 'running')`
      : `WHERE e.scheduler_lease_expires_at IS NOT NULL AND e.scheduler_lease_expires_at < ? AND e.state IN ('queued', 'running')`;
    const rows = this.context.database.prepare(`SELECT e.*, s.project_id, s.id AS session_id, r.root_objective FROM orchestration_executions e JOIN runs r ON r.id = e.run_id JOIN sessions s ON s.id = r.session_id ${where}`).all(...(projectId ? [now, projectId] : [now])) as ExecutionRow[];
    for (const row of rows) {
      this.context.database.prepare('UPDATE orchestration_executions SET scheduler_lease_owner = NULL, scheduler_lease_expires_at = NULL, updated_at = ? WHERE id = ?').run(now, row.id);
      // A disconnected node may leave a command in running forever. Once its
      // durable TTL passes, expire only states with no possible side effect;
      // uncertain is deliberately excluded for operator reconciliation.
      this.context.database.prepare(`UPDATE node_commands
        SET state = 'expired', completed_at = COALESCE(completed_at, ?), updated_at = ?
        WHERE operation_key LIKE 'orchestration:' || ? || ':%'
          AND state IN ('queued', 'delivered', 'accepted', 'running')
          AND expires_at <= ?`).run(now, now, row.id, now);
      // Reconcile any phase that completed before the scheduler process died.
      // The operation key makes this idempotent; the next phase is durable.
      if (row.state === 'queued' || row.state === 'running') this.reconcileExecutionInternal(row);
      const current = this.context.database.prepare('SELECT state FROM orchestration_executions WHERE id = ?').get(row.id) as { state: string } | undefined;
      if (!current || (current.state !== 'queued' && current.state !== 'running')) continue;
      // A process may have died between claiming and writing the command.  Requeue
      // those rows; operation_key keeps an already accepted node command idempotent.
      this.context.database.prepare(`UPDATE orchestration_work_items SET state = 'queued', machine_id = NULL, updated_at = ?
        WHERE execution_id = ? AND state IN ('claiming', 'scheduled', 'running') AND id NOT IN (
          SELECT w.id FROM orchestration_work_items w JOIN node_commands c
            ON c.machine_id = w.machine_id
           AND c.operation_key LIKE 'orchestration:' || w.execution_id || ':' || w.id || ':%'
          WHERE w.execution_id = ? AND c.state IN ('queued', 'delivered', 'accepted', 'running', 'uncertain')
        )`).run(now, row.id, row.id);
    }
    return rows.length;
  }

  private worktreeCleanupPending(execution: ExecutionRow, item: WorkRow): boolean {
    if (item.workspace_policy !== 'isolated' || item.attempt < 1) return false;
    const worktree = this.context.database.prepare(`SELECT machine_id, state FROM worktrees
      WHERE project_id = ? AND work_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(execution.project_id, item.id) as { machine_id: string; state: string } | undefined;
    if (!worktree || worktree.state === 'removed') return false;
    const setup = this.context.database.prepare('SELECT state FROM node_commands WHERE machine_id = ? AND operation_key = ? AND kind = \'create_worktree\'').get(worktree.machine_id, this.worktreeOperationKey(execution.id, item.id, item.attempt)) as { state: string } | undefined;
    if (!setup) return false;
    if (setup.state !== 'completed') return !['failed', 'cancelled', 'expired'].includes(setup.state);
    const remove = this.context.database.prepare('SELECT state FROM node_commands WHERE machine_id = ? AND operation_key = ? AND kind = \'remove_worktree\'').get(worktree.machine_id, `orchestration:${execution.id}:${item.id}:remove_worktree:${item.attempt}`) as { state: string } | undefined;
    return !remove || !['completed', 'failed', 'cancelled', 'expired'].includes(remove.state);
  }

  private scheduleExecutionInternal(execution: ExecutionRow): number {
    const version = this.context.database.prepare('SELECT * FROM orchestration_profile_versions WHERE id = ?').get(execution.profile_version_id) as ProfileVersionRow | undefined;
    if (!version) return 0;
    const config = this.profileConfig(version);
    let active = (this.context.database.prepare("SELECT count(*) AS count FROM orchestration_work_items WHERE execution_id = ? AND state IN ('claiming', 'scheduled', 'running', 'needs_input', 'reviewing')").get(execution.id) as { count: number }).count;
    let count = 0;
    this.context.database.prepare("UPDATE orchestration_work_items SET state = 'queued', error_summary = NULL, updated_at = ? WHERE execution_id = ? AND state = 'blocked' AND (error_summary LIKE 'Claim conflict:%' OR error_summary IN ('Orchestration budget exhausted', 'Orchestration budget is undeclared'))").run(this.now(), execution.id);
    const items = this.context.database.prepare("SELECT * FROM orchestration_work_items WHERE execution_id = ? AND state = 'queued' ORDER BY ordinal").all(execution.id) as WorkRow[];
    for (const item of items) {
      if (active >= execution.max_concurrency || active >= config.limits.maxConcurrency) break;
      if (this.worktreeCleanupPending(execution, item)) continue;
      if (item.depth > config.limits.maxDepth) {
        this.failWorkItemInternal(execution, item, 'Maximum orchestration depth exceeded', config);
        continue;
      }
      const dependency = this.dependencyState(item.id);
      if (dependency === 'waiting') continue;
      if (dependency === 'failed') {
        this.failWorkItemInternal(execution, item, 'A dependency failed', config);
        continue;
      }
      const budgetError = this.checkBudgetAdmission(execution, item, config);
      if (budgetError) {
        this.context.database.prepare("UPDATE orchestration_work_items SET state = 'blocked', error_summary = ?, updated_at = ? WHERE id = ? AND state = 'queued'").run(budgetError, this.now(), item.id);
        this.emit(execution.project_id, 'child.state.changed', 'orchestration_work_item', item.id, { executionId: execution.id, sessionId: execution.session_id, state: 'blocked', error: budgetError });
        continue;
      }
      const machine = this.selectMachine(item, config, execution.project_id);
      if (!machine) continue;
      let claim: { claimId: string; conflict?: CoordinationClaimResult['conflict'] };
      try {
        claim = this.claimBeforeSpawn(execution, item, machine.machine_id);
      } catch (error) {
        if (!(error instanceof BlockingOverlapError)) throw error;
        const reasons = error.conflicts.flatMap((conflict) => conflict.reasons.map((reason) => typeof reason === 'string' ? reason : JSON.stringify(reason))).join(', ');
        const summary = redactText(`Claim conflict: ${reasons}`, 2_000);
        this.context.database.prepare("UPDATE orchestration_work_items SET state = 'blocked', error_summary = ?, updated_at = ? WHERE id = ? AND state = 'queued'").run(summary, this.now(), item.id);
        this.emit(execution.project_id, 'child.state.changed', 'orchestration_work_item', item.id, { executionId: execution.id, sessionId: execution.session_id, state: 'blocked', error: summary });
        continue;
      }
      if (claim.conflict) {
        const summary = redactText(`Claim conflict: ${claim.conflict.reasons.join(', ')}`, 2_000);
        this.context.database.prepare("UPDATE orchestration_work_items SET state = 'blocked', error_summary = ?, updated_at = ? WHERE id = ?").run(summary, this.now(), item.id);
        this.emit(execution.project_id, 'child.state.changed', 'orchestration_work_item', item.id, { executionId: execution.id, sessionId: execution.session_id, state: 'blocked', error: summary });
        continue;
      }
      const now = this.now();
      const attempt = item.attempt + 1;
      const operationKey = `orchestration:${execution.id}:${item.id}:attempt:${attempt}`;
      const commandId = this.context.ids.id();
      const expiresAt = new Date(this.context.clock.now().getTime() + 24 * 60 * 60 * 1_000).toISOString();
      const workspace = this.context.database.prepare(`
        SELECT s.workspace_id, w.repository_id
        FROM runs r JOIN sessions s ON s.id = r.session_id
        LEFT JOIN workspaces w ON w.id = s.workspace_id
        WHERE r.id = ?
      `).get(execution.run_id) as { workspace_id: string | null; repository_id: string | null } | undefined;
      const repositoryId = workspace?.repository_id ?? (this.context.database.prepare('SELECT id FROM repositories WHERE project_id = ? ORDER BY created_at LIMIT 1').get(execution.project_id) as { id: string } | undefined)?.id;
      const repository = repositoryId
        ? this.context.database.prepare('SELECT default_branch FROM repositories WHERE id = ? AND project_id = ?').get(repositoryId, execution.project_id) as { default_branch: string | null } | undefined
        : undefined;
      const runtimeId = machine.runtime_kind ?? machine.runtime_id ?? undefined;
      if (!repositoryId || !runtimeId) {
        this.releaseClaim(claim.claimId, 'No repository or runtime is available on the selected machine');
        this.context.database.prepare("UPDATE orchestration_work_items SET state = 'failed', error_summary = ?, completed_at = ?, updated_at = ? WHERE id = ?").run('No repository or runtime is available on the selected machine', now, now, item.id);
        continue;
      }
      let payload: NodeCommand = {
        kind: 'create_runtime_session',
        commandId,
        operationKey,
        issuedAt: now,
        expiresAt,
        repositoryId,
        ...(workspace?.workspace_id ? { workspaceId: workspace.workspace_id } : {}),
        runtimeId,
        runtimeSessionKey: `orchestration-${execution.id}-${item.id}-${attempt}`,
        cwd: '.',
      };
      if (!config.fake && item.workspace_policy === 'isolated') {
        const relativeTarget = this.worktreeTarget(execution.id, item.id, attempt);
        const branch = this.worktreeBranch(execution.id, item.id, attempt);
        payload = {
          kind: 'create_worktree',
          commandId,
          operationKey: this.worktreeOperationKey(execution.id, item.id, attempt),
          issuedAt: now,
          expiresAt,
          repositoryId,
          relativeTarget,
          branch,
          baseRevision: repository?.default_branch ?? 'HEAD',
        };
        this.context.database.prepare(`INSERT OR IGNORE INTO worktrees(
          id, project_id, repository_id, machine_id, work_item_id, path_reference,
          branch, base_revision, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?)`)
          .run(this.context.ids.id(), execution.project_id, repositoryId, machine.machine_id, item.id, relativeTarget, branch, repository?.default_branch ?? 'HEAD', now, now);
      }
      try {
        if (config.fake) this.persistNodeCommand(machine.machine_id, execution.project_id, payload, attempt);
        else this.queueNodeCommand(machine.machine_id, execution.project_id, payload);
        this.context.database.prepare("UPDATE orchestration_work_items SET state = 'running', machine_id = ?, claim_id = ?, attempt = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND state = 'queued'").run(machine.machine_id, claim.claimId, attempt, now, now, item.id);
        this.emit(execution.project_id, 'child.started', 'orchestration_work_item', item.id, { executionId: execution.id, sessionId: execution.session_id, machineId: machine.machine_id, operationKey: payload.operationKey }, undefined);
        if (config.fake) {
          const result = { status: 'ok', deterministic: true, workItemId: item.id, ordinal: item.ordinal, attempt, machineId: machine.machine_id, output: `Completed ${item.objective}` };
          this.context.database.prepare("UPDATE node_commands SET state = 'completed', result_json = ?, completed_at = ?, updated_at = ? WHERE machine_id = ? AND operation_key = ?").run(json(result), now, now, machine.machine_id, payload.operationKey);
          this.settleWorkItemInternal(execution, item.id, result, undefined);
          settledChildrenHint();
        } else {
          active += 1;
        }
        count += 1;
      } catch (error) {
        const summary = redactText(error instanceof Error ? error.message : 'Spawn failed', 2_000);
        this.releaseClaim(claim.claimId, summary);
        this.context.database.prepare("UPDATE orchestration_work_items SET state = 'failed', error_summary = ?, completed_at = ?, updated_at = ? WHERE id = ?").run(summary, now, now, item.id);
        this.context.database.prepare("UPDATE worktrees SET state = 'failed', updated_at = ? WHERE work_item_id = ? AND state IN ('requested', 'creating', 'ready', 'in_use')").run(now, item.id);
        this.emit(execution.project_id, 'child.state.changed', 'orchestration_work_item', item.id, { executionId: execution.id, sessionId: execution.session_id, state: 'failed', error: summary });
      }
    }
    this.context.database.prepare("UPDATE orchestration_executions SET active_count = (SELECT count(*) FROM orchestration_work_items WHERE execution_id = ? AND state IN ('claiming', 'scheduled', 'running', 'needs_input', 'reviewing')), updated_at = ? WHERE id = ?").run(execution.id, this.now(), execution.id);
    return count;

    function settledChildrenHint(): void {
      // Kept as a local no-op to make the fake path explicit and deterministic;
      // aggregate reconciliation below observes the durable settled row.
    }
  }

  private dependencyState(itemId: string): 'ready' | 'waiting' | 'failed' {
    const rows = this.context.database.prepare('SELECT w.state FROM orchestration_dependencies d JOIN orchestration_work_items w ON w.id = d.depends_on_work_item_id WHERE d.work_item_id = ?').all(itemId) as Array<{ state: string }>;
    if (rows.some((row) => row.state === 'failed')) return 'failed';
    if (rows.some((row) => !TERMINAL_STATES.has(row.state))) return 'waiting';
    return 'ready';
  }

  private selectMachine(item: WorkRow, config: OrchestrationProfileConfig, projectId: string): MachineRow | undefined {
    const required = parseJson(item.required_capabilities_json) ?? {};
    const runtimeKinds = Array.isArray(required.$runtimeKinds) ? required.$runtimeKinds.filter((kind): kind is string => typeof kind === 'string') : [];
    const rows = this.context.database.prepare(`SELECT m.id AS machine_id, m.name AS machine_name, m.status AS machine_status,
      m.available_slots, rt.id AS runtime_id, rt.kind AS runtime_kind, rt.label AS runtime_label,
      rt.available AS runtime_available, rt.capabilities_json
      FROM machines m LEFT JOIN runtime_registrations rt ON rt.machine_id = m.id AND rt.available = 1
      WHERE m.status = 'connected' AND m.team_id = (SELECT team_id FROM projects WHERE id = ?) ${config.eligibleMachineIds.length ? `AND m.id IN (${config.eligibleMachineIds.map(() => '?').join(',')})` : ''}
      ORDER BY m.id, rt.id`).all(projectId, ...config.eligibleMachineIds) as MachineRow[];
    const candidates = rows.filter((row) => {
      const capabilities = parseJson(row.capabilities_json) ?? {};
      if (!row.runtime_id) return false;
      if (runtimeKinds.length && (!row.runtime_kind || !runtimeKinds.includes(row.runtime_kind))) return false;
      if (Object.entries(required).some(([key, expected]) => expected === true && capabilities[key] !== true)) return false;
      if ((row.available_slots ?? 0) <= 0) return false;
      const active = (this.context.database.prepare("SELECT count(*) AS count FROM orchestration_work_items WHERE machine_id = ? AND state IN ('claiming', 'scheduled', 'running', 'needs_input', 'reviewing')").get(row.machine_id) as { count: number }).count;
      return active < row.available_slots;
    });
    candidates.sort((left, right) => {
      const l = (this.context.database.prepare("SELECT count(*) AS count FROM orchestration_work_items WHERE machine_id = ? AND state IN ('claiming', 'scheduled', 'running', 'needs_input', 'reviewing')").get(left.machine_id) as { count: number }).count;
      const r = (this.context.database.prepare("SELECT count(*) AS count FROM orchestration_work_items WHERE machine_id = ? AND state IN ('claiming', 'scheduled', 'running', 'needs_input', 'reviewing')").get(right.machine_id) as { count: number }).count;
      return l - r || left.machine_id.localeCompare(right.machine_id);
    });
    return candidates[0];
  }

  private claimBeforeSpawn(execution: ExecutionRow, item: WorkRow, machineId: string): { claimId: string; conflict?: CoordinationClaimResult['conflict'] } {
    const scope = (parseJson(item.claim_scope_json) ?? {}) as ChildWorkItemInput['claimScope'];
    const input: CoordinationClaimInput = { projectId: execution.project_id, runId: execution.run_id, workItemId: item.id, scope, intent: item.objective };
    if (this.#coordination?.claim) {
      const result = this.#coordination.claim(input);
      if (result.conflict) return result;
      this.ensureClaimRow(result.claimId, execution, item, machineId, scope);
      return result;
    }
    if (this.#coordination?.reserveClaim) {
      // Native CoordinationService uses a session-scoped reserveClaim API.
      // The synthetic session contains no user prompt, path, or secret.
      this.ensureSyntheticSession(execution);
      const result = this.#coordination.reserveClaim(execution.project_id, {
        sessionId: `orchestration-session-${execution.id}`,
        runId: execution.run_id,
        workItemId: item.id,
        intent: item.objective,
        task: scope.task ?? null,
        files: scope.files ?? [],
        components: scope.components ?? [],
        worktree: scope.worktree ?? null,
        capability: execution.id,
        mode: 'enforced',
        enforce: true,
      });
      const claimId = result.claim.id;
      this.ensureClaimRow(claimId, execution, item, machineId, scope);
      return { claimId };
    }
    const files = Array.isArray(scope.files) ? scope.files.map(String) : [];
    const components = Array.isArray(scope.components) ? scope.components.map(String) : [];
    const predicates: string[] = [];
    const overlapParams: string[] = [execution.project_id];
    if (files.length) {
      predicates.push(`f.normalized_path IN (${files.map(() => '?').join(',')})`);
      overlapParams.push(...files);
    }
    if (components.length) {
      predicates.push(`cp.normalized_component IN (${components.map(() => '?').join(',')})`);
      overlapParams.push(...components);
    }
    const overlapping = predicates.length
      ? this.context.database.prepare(`SELECT DISTINCT c.id FROM coordination_claims c
        LEFT JOIN coordination_claim_files f ON f.claim_id = c.id
        LEFT JOIN coordination_claim_components cp ON cp.claim_id = c.id
        WHERE c.project_id = ? AND c.status IN ('investigating', 'in-progress', 'testing', 'blocked')
        AND (${predicates.join(' OR ')}) LIMIT 1`).get(...overlapParams) as { id: string } | undefined
      : undefined;
    if (overlapping) {
      const conflictId = this.context.ids.id();
      this.context.database.prepare('INSERT OR IGNORE INTO coordination_conflicts(id, project_id, claim_id, conflicting_claim_id, severity, reasons_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(conflictId, execution.project_id, overlapping.id, overlapping.id, 'blocking', json([{ type: 'files', detail: 'Overlapping orchestration claim' }]), this.now());
      return { claimId: '', conflict: { claimId: overlapping.id, severity: 'blocking', reasons: ['Overlapping coordination claim'] } };
    }
    const claimId = this.context.ids.id();
    const sessionId = `orchestration-session-${execution.id}`;
    const now = this.now();
    this.ensureSyntheticSession(execution);
    this.context.database.prepare(`INSERT INTO coordination_claims(id, project_id, coordination_session_id, run_id, work_item_id, intent, task, worktree_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in-progress', ?, ?)`)
      .run(claimId, execution.project_id, sessionId, execution.run_id, item.id, item.objective, scope.task ?? null, scope.worktree ?? null, now, now);
    for (const file of files) this.context.database.prepare('INSERT OR IGNORE INTO coordination_claim_files(claim_id, normalized_path) VALUES (?, ?)').run(claimId, file);
    for (const component of components) this.context.database.prepare('INSERT OR IGNORE INTO coordination_claim_components(claim_id, normalized_component) VALUES (?, ?)').run(claimId, component);
    return { claimId };
  }

  private ensureSyntheticSession(execution: ExecutionRow): void {
    const now = this.now();
    const sessionId = `orchestration-session-${execution.id}`;
    this.context.database.prepare(`INSERT OR IGNORE INTO coordination_sessions(id, project_id, agent_label, capability_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(sessionId, execution.project_id, 'orchestration-director', createHash('sha256').update(execution.id).digest('hex'), now, now, new Date(this.context.clock.now().getTime() + 86_400_000).toISOString());
  }

  private ensureClaimRow(claimId: string, execution: ExecutionRow, item: WorkRow, _machineId: string, scope: ChildWorkItemInput['claimScope']): void {
    const exists = this.context.database.prepare('SELECT id FROM coordination_claims WHERE id = ?').get(claimId) as { id: string } | undefined;
    if (exists) return;
    const sessionId = `orchestration-session-${execution.id}`;
    const now = this.now();
    this.context.database.prepare(`INSERT OR IGNORE INTO coordination_sessions(id, project_id, agent_label, capability_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(sessionId, execution.project_id, 'orchestration-director', createHash('sha256').update(execution.id).digest('hex'), now, now, new Date(this.context.clock.now().getTime() + 86_400_000).toISOString());
    this.context.database.prepare(`INSERT INTO coordination_claims(id, project_id, coordination_session_id, run_id, work_item_id, intent, task, worktree_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in-progress', ?, ?)`)
      .run(claimId, execution.project_id, sessionId, execution.run_id, item.id, item.objective, scope.task ?? null, scope.worktree ?? null, now, now);
  }

  private releaseClaim(claimId: string, reason: string): void {
    const claimProject = this.context.database.prepare('SELECT project_id FROM coordination_claims WHERE id = ?').get(claimId) as { project_id: string } | undefined;
    const capability = this.claimCapability(claimId);
    if (this.#coordination?.release) {
      try { this.#coordination.release({ claimId, reason }); } catch { /* release is best effort; DB remains authoritative */ }
    } else if (this.#coordination?.releaseClaim && claimProject) {
      try { this.#coordination.releaseClaim(claimProject.project_id, claimId, capability); } catch { /* release is best effort; DB transition below is authoritative */ }
    }
    const now = this.now();
    const safeReason = redactText(reason, 2_000);
    this.context.database.prepare("UPDATE coordination_claims SET status = 'released', summary = ?, updated_at = ?, completed_at = COALESCE(completed_at, ?) WHERE id = ? AND status NOT IN ('done', 'released', 'abandoned', 'expired')").run(safeReason, now, now, claimId);
    this.context.database.prepare('UPDATE coordination_conflicts SET resolved_at = ? WHERE (claim_id = ? OR conflicting_claim_id = ?) AND resolved_at IS NULL').run(now, claimId, claimId);
  }

  private settleClaim(claimId: string, summary: string): void {
    const claimProject = this.context.database.prepare('SELECT project_id FROM coordination_claims WHERE id = ?').get(claimId) as { project_id: string } | undefined;
    const capability = this.claimCapability(claimId);
    const safeSummary = redactText(summary, 2_000);
    if (this.#coordination?.settle) {
      try { this.#coordination.settle({ claimId, summary: safeSummary }); } catch { /* DB transition below is authoritative */ }
    } else if (this.#coordination?.completeClaim && claimProject) {
      try { this.#coordination.completeClaim(claimProject.project_id, claimId, { summary: safeSummary, ...(capability ? { capability } : {}) }); } catch { /* DB transition below is authoritative */ }
    }
    const now = this.now();
    this.context.database.prepare("UPDATE coordination_claims SET status = 'done', summary = ?, updated_at = ?, completed_at = COALESCE(completed_at, ?) WHERE id = ?").run(safeSummary, now, now, claimId);
    this.context.database.prepare('UPDATE coordination_conflicts SET resolved_at = ? WHERE (claim_id = ? OR conflicting_claim_id = ?) AND resolved_at IS NULL').run(now, claimId, claimId);
  }

  private claimCapability(claimId: string): string | undefined {
    const row = this.context.database.prepare(`SELECT e.id
      FROM coordination_claims c
      JOIN orchestration_work_items w ON w.id = c.work_item_id
      JOIN orchestration_executions e ON e.id = w.execution_id
      WHERE c.id = ?`).get(claimId) as { id: string } | undefined;
    return row?.id;
  }

  private settleWorkItemInternal(execution: ExecutionRow, workItemId: string, result: Record<string, unknown>, actorUserId?: string): void {
    const now = this.now();
    const safeResult = redactResult(result);
    const row = this.context.database.prepare('SELECT claim_id FROM orchestration_work_items WHERE id = ? AND execution_id = ?').get(workItemId, execution.id) as { claim_id: string | null } | undefined;
    this.context.database.prepare("UPDATE orchestration_work_items SET state = 'settled', result_json = ?, completed_at = ?, updated_at = ? WHERE id = ? AND execution_id = ?").run(json(safeResult), now, now, workItemId, execution.id);
    this.context.database.prepare("UPDATE worktrees SET state = 'settled', updated_at = ? WHERE work_item_id = ? AND state IN ('creating', 'ready', 'in_use')").run(now, workItemId);
    if (row?.claim_id) this.settleClaim(row.claim_id, String(result.output ?? 'settled'));
    this.emit(execution.project_id, 'child.state.changed', 'orchestration_work_item', workItemId, { executionId: execution.id, sessionId: execution.session_id, state: 'settled', result: safeResult }, actorUserId);
  }

  private failWorkItemInternal(execution: ExecutionRow, item: WorkRow, error: string, config: OrchestrationProfileConfig): void {
    const now = this.now();
    const safeError = redactText(error, 2_000);
    this.queueFailedWorktreeCleanup(execution, item);
    if (item.attempt <= config.limits.maxRetries) {
      this.context.database.prepare("UPDATE orchestration_work_items SET state = 'queued', error_summary = ?, machine_id = NULL, claim_id = NULL, updated_at = ? WHERE id = ?").run(safeError, now, item.id);
      if (item.claim_id) this.releaseClaim(item.claim_id, safeError);
      if (item.state !== 'queued') this.emit(execution.project_id, 'child.state.changed', 'orchestration_work_item', item.id, { executionId: execution.id, sessionId: execution.session_id, state: 'queued', error: safeError });
      return;
    }
    this.context.database.prepare("UPDATE orchestration_work_items SET state = 'failed', error_summary = ?, completed_at = ?, updated_at = ? WHERE id = ?").run(safeError, now, now, item.id);
    if (item.claim_id) this.releaseClaim(item.claim_id, safeError);
    if (item.state !== 'failed') this.emit(execution.project_id, 'child.state.changed', 'orchestration_work_item', item.id, { executionId: execution.id, sessionId: execution.session_id, state: 'failed', error: safeError });
  }

  private queueFailedWorktreeCleanup(execution: ExecutionRow, item: WorkRow): void {
    if (item.workspace_policy !== 'isolated' || !item.machine_id || item.attempt < 1) return;
    const now = this.now();
    this.context.database.prepare("UPDATE worktrees SET state = 'failed', updated_at = ? WHERE work_item_id = ? AND state IN ('requested', 'creating', 'ready', 'in_use')").run(now, item.id);
    try {
      this.queueRuntimeCancel(execution, item);
      this.queueWorktreeCleanup(execution, item, true);
    } catch { /* cleanup retries from the next scheduler tick */ }
  }

  private terminalizeExecutionItems(execution: ExecutionRow, state: 'settled' | 'failed' | 'cancelled', reason: string): void {
    const now = this.now();
    const items = this.context.database.prepare('SELECT * FROM orchestration_work_items WHERE execution_id = ? AND state NOT IN (\'settled\', \'failed\', \'cancelled\') ORDER BY ordinal').all(execution.id) as WorkRow[];
    for (const item of items) {
      this.stopWorkItemCommands(execution, item);
      if (item.workspace_policy === 'isolated') {
        this.context.database.prepare("UPDATE worktrees SET state = 'failed', updated_at = ? WHERE work_item_id = ? AND state IN ('requested', 'creating', 'ready', 'in_use')").run(now, item.id);
        try { this.queueWorktreeCleanup(execution, item, true); } catch { /* cleanup retries after terminalization */ }
      }
      if (item.claim_id) {
        if (state === 'settled') this.settleClaim(item.claim_id, reason);
        else this.releaseClaim(item.claim_id, reason);
      }
      // A fail-fast/linked failure marks the root failed and cancels sibling
      // work; callers still get one terminal state for every work item.
      const itemState = state === 'failed' && item.parent_work_item_id ? 'cancelled' : state;
      const changed = this.context.database.prepare('UPDATE orchestration_work_items SET state = ?, error_summary = ?, completed_at = ?, updated_at = ? WHERE id = ? AND state NOT IN (\'settled\', \'failed\', \'cancelled\')').run(itemState, state === 'settled' ? null : redactText(reason, 2_000), now, now, item.id).changes;
      if (changed === 1) this.emit(execution.project_id, 'child.state.changed', 'orchestration_work_item', item.id, {
        executionId: execution.id,
        sessionId: execution.session_id,
        state: itemState,
        ...(state === 'settled' ? {} : { error: redactText(reason, 2_000) }),
      });
    }
  }

  private stopWorkItemCommands(execution: ExecutionRow, item: WorkRow): void {
    if (!item.machine_id) return;
    const prefix = `orchestration:${execution.id}:${item.id}:`;
    const commands = this.context.database.prepare(`SELECT id, state, kind FROM node_commands
      WHERE machine_id = ? AND operation_key LIKE ? AND kind NOT IN ('cancel', 'remove_worktree')
        AND state NOT IN ('completed', 'failed', 'cancelled', 'expired')`).all(item.machine_id, `${prefix}%`) as Array<{ id: string; state: string; kind: string }>;
    const runtimeSessionId = this.runtimeSessionId(execution.id, item);
    if (runtimeSessionId && commands.some((command) => command.state === 'accepted' || command.state === 'running' || command.state === 'uncertain')) {
      this.queueRuntimeCancel(execution, item);
    }
    const now = this.now();
    for (const command of commands) {
      if (command.state === 'running' || command.state === 'uncertain') {
        // A running/uncertain command may already have side effects. Keep it
        // operator-reconcilable while preventing Fleet from redelivering it.
        if (command.state === 'running') this.context.database.prepare("UPDATE node_commands SET state = 'uncertain', updated_at = ? WHERE id = ? AND state = 'running'").run(now, command.id);
      } else {
        this.context.database.prepare("UPDATE node_commands SET state = 'cancelled', completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ? AND state NOT IN ('completed', 'failed', 'cancelled', 'expired', 'uncertain')").run(now, now, command.id);
      }
    }
  }

  private reconcileExecutionInternal(execution: ExecutionRow): number {
    const version = this.context.database.prepare('SELECT * FROM orchestration_profile_versions WHERE id = ?').get(execution.profile_version_id) as ProfileVersionRow | undefined;
    if (!version) return 0;
    const config = this.profileConfig(version);
    const items = this.context.database.prepare('SELECT * FROM orchestration_work_items WHERE execution_id = ? ORDER BY ordinal').all(execution.id) as WorkRow[];
    for (const item of items) {
      if (item.state !== 'running' || !item.machine_id) continue;
      const createKey = this.createOperationKey(execution.id, item.id, item.attempt);
      const turnKey = this.objectiveOperationKey(execution.id, item.id, item.attempt);
      const worktreeKey = this.worktreeOperationKey(execution.id, item.id, item.attempt);
      const command = this.context.database.prepare(`SELECT kind, state, result_json, error_summary FROM node_commands
        WHERE machine_id = ? AND operation_key IN (?, ?, ?)
        ORDER BY CASE operation_key WHEN ? THEN 0 WHEN ? THEN 1 ELSE 2 END LIMIT 1`)
        .get(item.machine_id, worktreeKey, createKey, turnKey, turnKey, createKey) as { kind: string; state: string; result_json: string | null; error_summary: string | null } | undefined;
      if (!command) continue;
      if (command.state === 'completed' && command.kind === 'create_worktree') {
        try {
          this.enqueueRuntimeAfterWorktree(execution, item);
        } catch (error) {
          this.failWorkItemInternal(execution, item, error instanceof Error ? error.message : 'Worktree activation failed', config);
        }
      } else if (command.state === 'completed' && command.kind === 'create_runtime_session') {
        const createResult = parseJson(command.result_json) ?? {};
        const runtimeSessionId = typeof createResult.runtimeSessionId === 'string' ? createResult.runtimeSessionId : undefined;
        if (!runtimeSessionId) this.failWorkItemInternal(execution, item, 'Runtime session creation returned no session id', config);
        else this.enqueueObjectiveTurn(execution, item, runtimeSessionId);
      } else if (command.state === 'completed') this.settleWorkItemInternal(execution, item.id, parseJson(command.result_json) ?? { status: 'ok' });
      else if (command.state === 'failed' || command.state === 'expired') this.failWorkItemInternal(execution, item, command.error_summary ?? `Node command ${command.state}`, config);
      else if (command.state === 'cancelled') {
        const now = this.now();
        this.context.database.prepare("UPDATE orchestration_work_items SET state = 'cancelled', error_summary = ?, completed_at = ?, updated_at = ? WHERE id = ?").run('Node command was cancelled', now, now, item.id);
        if (item.claim_id) this.releaseClaim(item.claim_id, 'node command cancelled');
        this.emit(execution.project_id, 'child.state.changed', 'orchestration_work_item', item.id, { executionId: execution.id, sessionId: execution.session_id, state: 'cancelled', error: 'Node command was cancelled' });
      // An uncertain node command may already have caused side effects. Keep
      // the work item running and leave the command for explicit operator
      // reconciliation; automatic failure, retry, and requeue are unsafe.
      }
    }
    const root = items.find((item) => !item.parent_work_item_id);
    if (!root) return 0;
    const descendants = items.filter((item) => item.id !== root.id);
    const allTerminal = descendants.every((item) => TERMINAL_STATES.has(item.state));
    const anyFailed = descendants.some((item) => item.state === 'failed');
    const anyCancelled = descendants.some((item) => item.state === 'cancelled');
    if (allTerminal && !TERMINAL_STATES.has(root.state)) {
      const now = this.now();
      const aggregate = redactResult({ executionId: execution.id, children: descendants.map((item) => ({ workItemId: item.id, state: item.state, result: parseJson(item.result_json), error: item.error_summary })) });
      const rootState = anyFailed ? 'failed' : anyCancelled ? 'cancelled' : 'settled';
      this.context.database.prepare('UPDATE orchestration_work_items SET state = ?, result_json = ?, error_summary = ?, completed_at = ?, updated_at = ? WHERE id = ?').run(rootState, json(aggregate), anyFailed ? 'One or more child work items failed' : null, now, now, root.id);
      this.emit(execution.project_id, 'child.state.changed', 'orchestration_work_item', root.id, { executionId: execution.id, sessionId: execution.session_id, state: rootState, result: aggregate });
    }
    const refreshed = this.context.database.prepare('SELECT state FROM orchestration_work_items WHERE execution_id = ?').all(execution.id) as Array<{ state: string }>;
    if (refreshed.length > 0 && refreshed.every((item) => item.state === 'settled')) {
      this.finishExecutionInternal(execution, 'settled', { children: refreshed.length });
      return 1;
    }
    if (refreshed.length > 0 && refreshed.every((item) => TERMINAL_STATES.has(item.state))) {
      const state = refreshed.some((item) => item.state === 'failed') ? 'failed' : 'cancelled';
      this.finishExecutionInternal(execution, state, { reason: state === 'failed' ? 'child_failed' : 'child_cancelled' });
      return 1;
    }
    if (refreshed.some((item) => item.state === 'failed') && config.completion.failFast) {
      this.terminalizeExecutionItems(execution, 'failed', 'Cancelled by fail-fast after a child failed');
      this.finishExecutionInternal(execution, 'failed', { reason: 'child_failed' });
      return 1;
    }
    return 0;
  }

  private enqueueObjectiveTurn(execution: ExecutionRow, item: WorkRow, runtimeSessionId: string): void {
    if (!item.machine_id) return;
    const operationKey = this.objectiveOperationKey(execution.id, item.id, item.attempt);
    const existing = this.context.database.prepare('SELECT id FROM node_commands WHERE machine_id = ? AND operation_key = ?').get(item.machine_id, operationKey);
    if (existing) return;
    const now = this.now();
    const expiresAt = new Date(this.context.clock.now().getTime() + 24 * 60 * 60 * 1_000).toISOString();
    const command: NodeCommand = {
      kind: 'send_message',
      commandId: this.context.ids.id(),
      operationKey,
      issuedAt: now,
      expiresAt,
      runtimeSessionId,
      message: redactOutboundText(item.objective),
    };
    this.queueNodeCommand(item.machine_id, execution.project_id, command);
  }

  private createOperationKey(executionId: string, workItemId: string, attempt: number): string {
    return `orchestration:${executionId}:${workItemId}:attempt:${attempt}`;
  }

  private objectiveOperationKey(executionId: string, workItemId: string, attempt: number): string {
    return `orchestration:${executionId}:${workItemId}:turn:${attempt}`;
  }

  private worktreeOperationKey(executionId: string, workItemId: string, attempt: number): string {
    return `orchestration:${executionId}:${workItemId}:worktree:${attempt}`;
  }

  private worktreeTarget(executionId: string, workItemId: string, attempt: number): string {
    return `.dhole/worktrees/${executionId}/${workItemId}-${attempt}`;
  }

  private worktreeBranch(executionId: string, workItemId: string, attempt: number): string {
    return `dhole/${executionId.slice(0, 12)}/${workItemId.slice(0, 12)}-${attempt}`;
  }

  private enqueueRuntimeAfterWorktree(execution: ExecutionRow, item: WorkRow): void {
    if (!item.machine_id) throw new Error('Work item has no assigned machine');
    const existing = this.context.database.prepare('SELECT id FROM node_commands WHERE machine_id = ? AND operation_key = ?')
      .get(item.machine_id, this.createOperationKey(execution.id, item.id, item.attempt));
    if (existing) return;
    const worktree = this.context.database.prepare(`SELECT repository_id, path_reference FROM worktrees
      WHERE project_id = ? AND machine_id = ? AND work_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(execution.project_id, item.machine_id, item.id) as { repository_id: string; path_reference: string } | undefined;
    if (!worktree) throw new Error('Completed worktree has no durable record');
    const required = parseJson(item.required_capabilities_json) ?? {};
    const runtimeKinds = Array.isArray(required.$runtimeKinds) ? required.$runtimeKinds.filter((kind): kind is string => typeof kind === 'string') : [];
    const runtimes = this.context.database.prepare(`SELECT id, kind, capabilities_json FROM runtime_registrations
      WHERE machine_id = ? AND available = 1 ${runtimeKinds.length ? `AND kind IN (${runtimeKinds.map(() => '?').join(',')})` : ''}
      ORDER BY id`)
      .all(item.machine_id, ...runtimeKinds) as Array<{ id: string; kind: string; capabilities_json: string }>;
    const runtime = runtimes.find((candidate) => {
      const capabilities = parseJson(candidate.capabilities_json) ?? {};
      return !Object.entries(required).some(([key, expected]) => expected === true && capabilities[key] !== true);
    });
    if (!runtime) throw new Error('Assigned machine has no available runtime');
    const now = this.now();
    const command: NodeCommand = {
      kind: 'create_runtime_session',
      commandId: this.context.ids.id(),
      operationKey: this.createOperationKey(execution.id, item.id, item.attempt),
      issuedAt: now,
      expiresAt: new Date(this.context.clock.now().getTime() + 24 * 60 * 60 * 1_000).toISOString(),
      repositoryId: worktree.repository_id,
      runtimeId: runtime.kind || runtime.id,
      runtimeSessionKey: `orchestration-${execution.id}-${item.id}-${item.attempt}`,
      cwd: worktree.path_reference,
    };
    this.queueNodeCommand(item.machine_id, execution.project_id, command);
    this.context.database.prepare("UPDATE worktrees SET state = 'in_use', updated_at = ? WHERE project_id = ? AND machine_id = ? AND work_item_id = ? AND state IN ('creating', 'ready')")
      .run(now, execution.project_id, item.machine_id, item.id);
  }

  private persistNodeCommand(machineId: string, projectId: string, command: NodeCommand, attempt = 0): void {
    this.context.database.prepare(`INSERT OR IGNORE INTO node_commands(
      id, machine_id, project_id, operation_key, kind, payload_json, state,
      attempt_count, created_at, expires_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`)
      .run(command.commandId, machineId, projectId, command.operationKey, command.kind, json(command), attempt, command.issuedAt, command.expiresAt, command.issuedAt);
  }

  private queueNodeCommand(machineId: string, projectId: string, command: NodeCommand): void {
    if (!this.#fleet) {
      this.persistNodeCommand(machineId, projectId, command);
      return;
    }
    this.#fleet.enqueueCommand({ machineId, projectId, command });
    // Fleet defers delivery while the enclosing transaction is open; retry
    // once the commit is visible to the node transport.
    if (this.#fleet.deliverPending) queueMicrotask(() => this.#fleet?.deliverPending?.(machineId));
  }

  private runtimeSessionId(executionId: string, item: WorkRow): string | undefined {
    if (!item.machine_id || item.attempt < 1) return undefined;
    const row = this.context.database.prepare(`SELECT result_json FROM node_commands
      WHERE machine_id = ? AND operation_key = ? AND kind = 'create_runtime_session' AND state = 'completed'`)
      .get(item.machine_id, this.createOperationKey(executionId, item.id, item.attempt)) as { result_json: string | null } | undefined;
    const result = parseJson(row?.result_json);
    return typeof result?.runtimeSessionId === 'string' ? result.runtimeSessionId : undefined;
  }

  private queueRuntimeCancel(execution: ExecutionRow, item: WorkRow): void {
    if (!item.machine_id) return;
    const runtimeSessionId = this.runtimeSessionId(execution.id, item);
    if (!runtimeSessionId) return;
    const now = this.now();
    const command: NodeCommand = {
      kind: 'cancel',
      commandId: this.context.ids.id(),
      operationKey: `orchestration:${execution.id}:${item.id}:cancel:${item.attempt}`,
      issuedAt: now,
      expiresAt: new Date(this.context.clock.now().getTime() + 60_000).toISOString(),
      runtimeSessionId,
    };
    this.queueNodeCommand(item.machine_id, execution.project_id, command);
  }

  private reconcileCancelledWorktreeCleanup(projectId?: string): void {
    const rows = this.context.database.prepare(`SELECT e.*, s.project_id, s.id AS session_id, r.root_objective,
      w.id AS work_item_id
      FROM orchestration_executions e
      JOIN runs r ON r.id = e.run_id
      JOIN sessions s ON s.id = r.session_id
      JOIN orchestration_work_items w ON w.execution_id = e.id
      WHERE w.workspace_policy = 'isolated'
        AND ((e.state = 'cancelled' AND w.state = 'cancelled')
          OR (e.state IN ('queued', 'running', 'failed', 'cancelled') AND w.state IN ('queued', 'failed', 'cancelled')))
        ${projectId ? 'AND s.project_id = ?' : ''}
      ORDER BY e.updated_at`).all(...(projectId ? [projectId] : [])) as Array<ExecutionRow & { work_item_id: string }>;
    for (const execution of rows) {
      const item = this.context.database.prepare('SELECT * FROM orchestration_work_items WHERE id = ? AND execution_id = ?').get(execution.work_item_id, execution.id) as WorkRow | undefined;
      if (item) this.queueWorktreeCleanup(execution, item, true);
    }
  }

  private reconcileWorktreeCommandResults(projectId?: string): void {
    const rows = this.context.database.prepare(`SELECT id, project_id, machine_id, payload_json, state
      FROM node_commands
      WHERE kind = 'remove_worktree' AND state IN ('completed', 'failed', 'expired', 'cancelled') ${projectId ? 'AND project_id = ?' : ''}
      ORDER BY updated_at`).all(...(projectId ? [projectId] : [])) as Array<{
        id: string;
        project_id: string | null;
        machine_id: string;
        payload_json: string;
        state: string;
      }>;
    for (const row of rows) {
      if (!row.project_id) continue;
      const payload = parseJson(row.payload_json);
      const repositoryId = typeof payload?.repositoryId === 'string' ? payload.repositoryId : undefined;
      const relativeTarget = typeof payload?.relativeTarget === 'string' ? payload.relativeTarget : undefined;
      if (!repositoryId || !relativeTarget) continue;
      const worktree = this.context.database.prepare(`SELECT id, state FROM worktrees
        WHERE project_id = ? AND machine_id = ? AND repository_id = ? AND path_reference = ?
        LIMIT 1`).get(row.project_id, row.machine_id, repositoryId, relativeTarget) as { id: string; state: string } | undefined;
      if (!worktree) continue;
      const next = row.state === 'completed' ? 'removed' : 'failed';
      if (next === 'removed' || worktree.state !== 'removed') {
        this.context.database.prepare('UPDATE worktrees SET state = ?, updated_at = ? WHERE id = ? AND state <> ?').run(next, this.now(), worktree.id, next);
      }
    }
  }

  private queueWorktreeCleanup(execution: ExecutionRow, item: WorkRow, deferred = false): void {
    if (item.workspace_policy !== 'isolated' || item.attempt < 1) return;
    const worktree = this.context.database.prepare(`SELECT repository_id, path_reference, machine_id, state
      FROM worktrees WHERE project_id = ? AND work_item_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(execution.project_id, item.id) as { repository_id: string; path_reference: string; machine_id: string; state: string } | undefined;
    const machineId = item.machine_id ?? worktree?.machine_id;
    if (!machineId) return;
    if (!worktree || (!['creating', 'ready', 'in_use'].includes(worktree.state) && !(deferred && worktree.state === 'failed'))) return;
    const setup = this.context.database.prepare('SELECT state FROM node_commands WHERE machine_id = ? AND operation_key = ? AND kind = \'create_worktree\'').get(machineId, this.worktreeOperationKey(execution.id, item.id, item.attempt)) as { state: string } | undefined;
    // Cleanup is only safe after setup is complete; deferred cleanup additionally
    // waits for a successful runtime cancellation and terminal sibling commands.
    if (!setup || setup.state !== 'completed') return;
    const runtimeSessionId = this.runtimeSessionId(execution.id, { ...item, machine_id: machineId });
    if (!deferred && runtimeSessionId) return;
    const runtimeSetup = this.context.database.prepare('SELECT state FROM node_commands WHERE machine_id = ? AND operation_key = ? AND kind = \'create_runtime_session\'').get(machineId, this.createOperationKey(execution.id, item.id, item.attempt)) as { state: string } | undefined;
    if (runtimeSetup && !['failed', 'cancelled', 'expired'].includes(runtimeSetup.state) && !(deferred && runtimeSessionId && runtimeSetup.state === 'completed')) return;
    if (deferred) {
      const prefix = `orchestration:${execution.id}:${item.id}:`;
      const active = this.context.database.prepare("SELECT id FROM node_commands WHERE machine_id = ? AND operation_key LIKE ? AND kind <> 'remove_worktree' AND state NOT IN ('completed', 'failed', 'cancelled', 'expired') LIMIT 1").get(machineId, `${prefix}%`);
      if (active) return;
      if (runtimeSessionId) {
        const completed = this.context.database.prepare("SELECT id FROM node_commands WHERE machine_id = ? AND operation_key LIKE ? AND kind = 'cancel' AND state = 'completed' LIMIT 1").get(machineId, `${prefix}%`);
        if (!completed) return;
      }
    }
    const operationKey = `orchestration:${execution.id}:${item.id}:remove_worktree:${item.attempt}`;
    if (this.context.database.prepare('SELECT id FROM node_commands WHERE machine_id = ? AND operation_key = ?').get(machineId, operationKey)) return;
    const now = this.now();
    const command: NodeCommand = {
      kind: 'remove_worktree',
      commandId: this.context.ids.id(),
      operationKey,
      issuedAt: now,
      expiresAt: new Date(this.context.clock.now().getTime() + 60 * 60_000).toISOString(),
      repositoryId: worktree.repository_id,
      relativeTarget: worktree.path_reference,
    };
    this.queueNodeCommand(machineId, execution.project_id, command);
  }

  private finishExecutionInternal(execution: ExecutionRow, state: 'settled' | 'failed' | 'cancelled', result: Record<string, unknown>, emitRunEvent = true): void {
    const now = this.now();
    const safeResult = redactResult(result);
    const linkedRun = this.context.database.prepare('SELECT state FROM runs WHERE id = ?').get(execution.run_id) as { state: string } | undefined;
    if (linkedRun && TERMINAL_STATES.has(linkedRun.state) && linkedRun.state !== state) return;
    this.context.database.prepare('UPDATE orchestration_executions SET state = ?, active_count = 0, completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ?').run(state, now, now, execution.id);
    this.context.database.prepare("UPDATE runs SET state = ?, completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ? AND (state NOT IN ('settled', 'failed', 'cancelled') OR state = ?)").run(state, now, now, execution.run_id, state);
    if (emitRunEvent) this.emit(execution.project_id, state === 'settled' ? 'run.settled' : 'run.failed', 'run', execution.run_id, { executionId: execution.id, sessionId: execution.session_id, result: safeResult });
  }

  private loadExecution(projectId: string, executionId: string): ExecutionRow | undefined {
    return this.context.database.prepare(`SELECT e.*, s.project_id, s.id AS session_id, r.root_objective FROM orchestration_executions e
      JOIN runs r ON r.id = e.run_id JOIN sessions s ON s.id = r.session_id WHERE e.id = ? AND s.project_id = ?`).get(executionId, projectId) as ExecutionRow | undefined;
  }

  private viewExecution(execution: ExecutionRow): ExecutionView {
    const rows = this.context.database.prepare('SELECT * FROM orchestration_work_items WHERE execution_id = ? ORDER BY ordinal').all(execution.id) as WorkRow[];
    const dependencies = new Map<string, string[]>();
    for (const row of this.context.database.prepare('SELECT work_item_id, depends_on_work_item_id FROM orchestration_dependencies WHERE work_item_id IN (SELECT id FROM orchestration_work_items WHERE execution_id = ?)').all(execution.id) as Array<{ work_item_id: string; depends_on_work_item_id: string }>) {
      dependencies.set(row.work_item_id, [...(dependencies.get(row.work_item_id) ?? []), row.depends_on_work_item_id]);
    }
    const workItems = rows.map((row): WorkItemView => ({
      id: row.id,
      executionId: row.execution_id,
      ...(row.parent_work_item_id ? { parentWorkItemId: row.parent_work_item_id } : {}),
      objective: row.objective,
      state: row.state,
      depth: row.depth,
      ordinal: row.ordinal,
      attempt: row.attempt,
      ...(row.machine_id ? { machineId: row.machine_id } : {}),
      ...(row.claim_id ? { claimId: row.claim_id } : {}),
      ...(parseJson(row.result_json) ? { result: parseJson(row.result_json) } : {}),
      ...(row.error_summary ? { errorSummary: row.error_summary } : {}),
      dependencies: dependencies.get(row.id) ?? [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    }));
    const result: Record<string, unknown> | undefined = execution.state === 'settled' ? { workItems: workItems.filter((item) => item.parentWorkItemId).map((item) => item.result) } : undefined;
    return {
      id: execution.id,
      projectId: execution.project_id,
      runId: execution.run_id,
      profileVersionId: execution.profile_version_id,
      state: execution.state,
      maxConcurrency: execution.max_concurrency,
      activeCount: execution.active_count,
      ...(execution.scheduler_lease_owner ? { leaseOwner: execution.scheduler_lease_owner } : {}),
      ...(execution.scheduler_lease_expires_at ? { leaseExpiresAt: execution.scheduler_lease_expires_at } : {}),
      workItems,
      ...(result ? { result } : {}),
      createdAt: execution.created_at,
      ...(execution.started_at ? { startedAt: execution.started_at } : {}),
      ...(execution.completed_at ? { completedAt: execution.completed_at } : {}),
      updatedAt: execution.updated_at,
    };
  }

  getExecution(projectId: string, executionId: string): ExecutionView {
    const row = this.loadExecution(projectId, executionId);
    if (!row) throw new Error('Unknown orchestration execution');
    return this.viewExecution(row);
  }

  listMachines(projectId: string): MachineCapability[] {
    const rows = this.context.database.prepare(`SELECT m.id AS machine_id, m.name AS machine_name, m.status AS machine_status, m.available_slots,
      rt.id AS runtime_id, rt.kind AS runtime_kind, rt.label AS runtime_label, rt.capabilities_json
      FROM machines m LEFT JOIN runtime_registrations rt ON rt.machine_id = m.id AND rt.available = 1
      WHERE m.team_id = (SELECT team_id FROM projects WHERE id = ?) AND m.status = 'connected' ORDER BY m.id, rt.id`).all(projectId) as Array<Omit<MachineRow, 'runtime_available'>>;
    const result = new Map<string, MachineCapability>();
    for (const row of rows) {
      const current = result.get(row.machine_id) ?? { machineId: row.machine_id, name: row.machine_name, availableSlots: row.available_slots, status: row.machine_status, runtime: [] };
      if (row.runtime_id) current.runtime.push({ id: row.runtime_id, kind: row.runtime_kind ?? 'unknown', label: row.runtime_label ?? row.runtime_kind ?? 'runtime', capabilities: parseJson(row.capabilities_json) ?? {} });
      result.set(row.machine_id, current);
    }
    return [...result.values()];
  }

  readContext(projectId: string, runId: string): { execution?: ExecutionView; machines: MachineCapability[]; claims: unknown[] } {
    const execution = this.context.database.prepare(`SELECT e.id FROM orchestration_executions e JOIN runs r ON r.id = e.run_id JOIN sessions s ON s.id = r.session_id WHERE e.run_id = ? AND s.project_id = ?`).get(runId, projectId) as { id: string } | undefined;
    const claims = this.context.database.prepare('SELECT id, status, intent, task, worktree_hash AS worktree, created_at, updated_at, completed_at FROM coordination_claims WHERE project_id = ? AND run_id = ? ORDER BY created_at').all(projectId, runId);
    return { ...(execution ? { execution: this.getExecution(projectId, execution.id) } : {}), machines: this.listMachines(projectId), claims };
  }

  createChild(input: unknown): WorkItemView {
    const value = ChildWorkItemInputSchema.parse(input);
    return this.transaction(() => {
      this.reconcileLinkedTerminalStates(value.projectId);
      const execution = this.loadExecution(value.projectId, value.executionId);
      if (!execution) throw new Error('Unknown orchestration execution');
      if (TERMINAL_STATES.has(execution.state)) throw new HttpError(409, 'execution_terminal', 'Orchestration execution is terminal');
      const profile = this.context.database.prepare('SELECT * FROM orchestration_profile_versions WHERE id = ?').get(execution.profile_version_id) as ProfileVersionRow;
      const config = this.profileConfig(profile);
      const profileBudget = parseBudget(config.limits.budget);
      const requestedBudget = validateBudget(value.budget);
      if (profileBudget.maxTokens !== undefined && requestedBudget.maxTokens !== undefined && requestedBudget.maxTokens > profileBudget.maxTokens) throw new Error('Child budget exceeds profile budget');
      if (profileBudget.maxCostMicrousd !== undefined && requestedBudget.maxCostMicrousd !== undefined && requestedBudget.maxCostMicrousd > profileBudget.maxCostMicrousd) throw new Error('Child budget exceeds profile budget');
      const childBudget: Record<string, unknown> = { ...value.budget };
      if (profileBudget.maxTokens !== undefined && requestedBudget.maxTokens === undefined) childBudget.maxTokens = profileBudget.maxTokens;
      if (profileBudget.maxCostMicrousd !== undefined && requestedBudget.maxCostMicrousd === undefined) childBudget.maxCostMicrousd = profileBudget.maxCostMicrousd;
      const reserved = this.budgetUsage(value.executionId, true);
      if (profileBudget.maxTokens !== undefined && reserved.tokens + (parseBudget(childBudget).maxTokens ?? 0) > profileBudget.maxTokens) throw new Error('Child budget exceeds remaining orchestration budget');
      if (profileBudget.maxCostMicrousd !== undefined && reserved.costMicrousd + (parseBudget(childBudget).maxCostMicrousd ?? 0) > profileBudget.maxCostMicrousd) throw new Error('Child budget exceeds remaining orchestration budget');
      const parentId = value.parentWorkItemId ?? (this.context.database.prepare('SELECT id FROM orchestration_work_items WHERE execution_id = ? AND parent_work_item_id IS NULL').get(value.executionId) as { id: string } | undefined)?.id;
      if (!parentId) throw new Error('Parent work item is required');
      const parent = this.context.database.prepare('SELECT depth FROM orchestration_work_items WHERE id = ? AND execution_id = ?').get(parentId, value.executionId) as { depth: number } | undefined;
      if (!parent) throw new Error('Unknown parent work item');
      if (parent.depth + 1 > config.limits.maxDepth) throw new Error('Maximum orchestration depth exceeded');
      const children = (this.context.database.prepare('SELECT count(*) AS count FROM orchestration_work_items WHERE execution_id = ? AND parent_work_item_id = ?').get(value.executionId, parentId) as { count: number }).count;
      if (children >= config.limits.maxChildrenPerParent) throw new Error('Maximum children per parent exceeded');
      const count = (this.context.database.prepare('SELECT count(*) AS count FROM orchestration_work_items WHERE execution_id = ?').get(value.executionId) as { count: number }).count;
      if (count >= config.limits.maxWorkItems) throw new Error('Maximum work item budget exceeded');
      const ordinal = (this.context.database.prepare('SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM orchestration_work_items WHERE execution_id = ?').get(value.executionId) as { ordinal: number }).ordinal;
      const id = this.context.ids.id();
      const now = this.now();
      const scope = value.claimScope.intent ? value.claimScope : { ...value.claimScope, intent: value.objective };
      this.context.database.prepare(`INSERT INTO orchestration_work_items(
        id, execution_id, parent_work_item_id, objective, deliverables_json, acceptance_json,
        required_capabilities_json, claim_scope_json, workspace_policy, budget_json,
        depth, ordinal, attempt, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'queued', ?, ?)`)
        .run(id, value.executionId, parentId, value.objective, json(value.deliverables), json(value.acceptance), json(value.requiredCapabilities), json(scope), value.workspacePolicy, json(childBudget), parent.depth + 1, ordinal, now, now);
      for (const dependency of value.dependsOnWorkItemIds) {
        const exists = this.context.database.prepare('SELECT id FROM orchestration_work_items WHERE id = ? AND execution_id = ?').get(dependency, value.executionId) as { id: string } | undefined;
        if (!exists) throw new Error(`Unknown dependency ${dependency}`);
        this.context.database.prepare('INSERT INTO orchestration_dependencies(work_item_id, depends_on_work_item_id) VALUES (?, ?)').run(id, dependency);
      }
      this.emit(execution.project_id, 'child.discovered', 'orchestration_work_item', id, { executionId: value.executionId, sessionId: execution.session_id, parentWorkItemId: parentId }, undefined);
      return this.viewWorkItem(id);
    });
  }

  childStatus(projectId: string, executionId: string, workItemId: string): WorkItemView {
    const execution = this.loadExecution(projectId, executionId);
    if (!execution) throw new Error('Unknown orchestration execution');
    const row = this.context.database.prepare('SELECT id FROM orchestration_work_items WHERE id = ? AND execution_id = ?').get(workItemId, executionId) as { id: string } | undefined;
    if (!row) throw new Error('Unknown child work item');
    return this.viewWorkItem(workItemId);
  }

  private viewWorkItem(workItemId: string): WorkItemView {
    const row = this.context.database.prepare('SELECT * FROM orchestration_work_items WHERE id = ?').get(workItemId) as WorkRow | undefined;
    if (!row) throw new Error('Unknown work item');
    const deps = this.context.database.prepare('SELECT depends_on_work_item_id FROM orchestration_dependencies WHERE work_item_id = ?').all(workItemId) as Array<{ depends_on_work_item_id: string }>;
    return {
      id: row.id, executionId: row.execution_id, ...(row.parent_work_item_id ? { parentWorkItemId: row.parent_work_item_id } : {}), objective: row.objective,
      state: row.state, depth: row.depth, ordinal: row.ordinal, attempt: row.attempt, ...(row.machine_id ? { machineId: row.machine_id } : {}), ...(row.claim_id ? { claimId: row.claim_id } : {}), ...(parseJson(row.result_json) ? { result: parseJson(row.result_json) } : {}), ...(row.error_summary ? { errorSummary: row.error_summary } : {}), dependencies: deps.map((d) => d.depends_on_work_item_id), createdAt: row.created_at, updatedAt: row.updated_at, ...(row.started_at ? { startedAt: row.started_at } : {}), ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    };
  }

  sendMessage(projectId: string, executionId: string, workItemId: string, message: string): { operationKey: string; commandId: string } {
    if (message.length < 1 || message.length > 200_000) throw new Error('Message length is invalid');
    return this.transaction(() => {
      this.reconcileLinkedTerminalStates(projectId);
      const execution = this.loadExecution(projectId, executionId);
      if (!execution) throw new Error('Unknown orchestration execution');
      if (TERMINAL_STATES.has(execution.state)) throw new HttpError(409, 'execution_terminal', 'Orchestration execution is terminal');
      const row = this.context.database.prepare('SELECT * FROM orchestration_work_items WHERE id = ? AND execution_id = ?').get(workItemId, executionId) as WorkRow | undefined;
      if (!row) throw new Error('Unknown child work item');
      if (TERMINAL_STATES.has(row.state)) throw new HttpError(409, 'work_item_terminal', 'Work item is terminal');
      if (!row.machine_id) throw new Error('Child has no assigned machine');
      const runtimeSessionId = this.runtimeSessionId(executionId, row);
      if (!runtimeSessionId) throw new Error('Child runtime session is not available');
      const commandId = this.context.ids.id();
      const operationKey = `orchestration:${executionId}:${workItemId}:message:${commandId}`;
      const now = this.now();
      const expiresAt = new Date(this.context.clock.now().getTime() + 86_400_000).toISOString();
      const command: NodeCommand = { kind: 'send_message', commandId, operationKey, issuedAt: now, expiresAt, runtimeSessionId, message: redactOutboundText(message) };
      this.queueNodeCommand(row.machine_id, projectId, command);
      return { operationKey, commandId };
    });
  }

  wait(projectId: string, executionId: string): ExecutionView {
    return this.getExecution(projectId, executionId);
  }

  cancelChild(projectId: string, executionId: string, workItemId: string): WorkItemView {
    this.transaction(() => {
      this.reconcileLinkedTerminalStates(projectId);
      const execution = this.loadExecution(projectId, executionId);
      if (!execution) throw new Error('Unknown orchestration execution');
      if (TERMINAL_STATES.has(execution.state)) throw new HttpError(409, 'execution_terminal', 'Orchestration execution is terminal');
      const row = this.context.database.prepare('SELECT * FROM orchestration_work_items WHERE id = ? AND execution_id = ?').get(workItemId, executionId) as WorkRow | undefined;
      if (!row) throw new Error('Unknown child work item');
      if (TERMINAL_STATES.has(row.state)) return;
      this.queueRuntimeCancel(execution, row);
      this.queueWorktreeCleanup(execution, row);
      const now = this.now();
      const changed = this.context.database.prepare("UPDATE orchestration_work_items SET state = 'cancelled', error_summary = 'Cancelled by director', completed_at = ?, updated_at = ? WHERE id = ? AND state NOT IN ('settled', 'failed', 'cancelled')").run(now, now, workItemId).changes;
      this.context.database.prepare("UPDATE worktrees SET state = 'failed', updated_at = ? WHERE work_item_id = ? AND state IN ('requested', 'creating', 'ready', 'in_use')").run(now, workItemId);
      if (row.claim_id) this.releaseClaim(row.claim_id, 'child cancelled');
      if (row.machine_id) this.context.database.prepare("UPDATE node_commands SET state = 'cancelled', updated_at = ?, completed_at = COALESCE(completed_at, ?) WHERE machine_id = ? AND operation_key LIKE ? AND kind NOT IN ('cancel', 'remove_worktree') AND state NOT IN ('completed', 'failed', 'cancelled', 'expired', 'uncertain')").run(now, now, row.machine_id, `orchestration:${executionId}:${row.id}:%`);
      if (changed === 1) this.emit(projectId, 'child.state.changed', 'orchestration_work_item', workItemId, { executionId, sessionId: execution.session_id, state: 'cancelled', error: 'Cancelled by director' });
      this.context.database.prepare('UPDATE orchestration_executions SET scheduler_lease_owner = NULL, scheduler_lease_expires_at = NULL, updated_at = ? WHERE id = ?').run(now, executionId);
    });
    this.tick(projectId);
    return this.childStatus(projectId, executionId, workItemId);
  }

  output(projectId: string, executionId: string, workItemId: string): Record<string, unknown> | undefined {
    return this.childStatus(projectId, executionId, workItemId).result;
  }

  proposeMemory(projectId: string, executionId: string, input: { packId: string; title: string; body: string; sourceReference?: string; sourceType?: string; userId?: string }): { id: string; state: string } {
    const sourceReference = input.sourceReference ?? executionId;
    const sourceType = input.sourceType ?? 'orchestration';
    if ([input.title, input.body, sourceType, sourceReference].some(containsProposalCredential)) {
      throw new HttpError(422, 'memory_secret_forbidden', 'Memory content must not contain credentials');
    }
    return this.transaction(() => {
      const execution = this.loadExecution(projectId, executionId);
      if (!execution) throw new Error('Unknown orchestration execution');
      const id = this.context.ids.id();
      this.context.database.prepare('INSERT INTO memory_proposals(id, pack_id, proposed_by_user_id, title, body, source_type, source_reference, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, \'pending\', ?)').run(id, input.packId, input.userId ?? null, input.title.slice(0, 240), input.body.slice(0, 200_000), sourceType, sourceReference, this.now());
      recordAudit(this.context, {
        projectId,
        actorType: input.userId ? 'user' : 'system',
        ...(input.userId ? { actorId: input.userId } : {}),
        action: 'memory.propose',
        targetType: 'memory_proposal',
        targetId: id,
        outcome: 'allowed',
        detail: { executionId, packId: input.packId },
      });
      this.emit(projectId, 'memory.proposed', 'memory_proposal', id, { executionId }, input.userId);
      return { id, state: 'pending' };
    });
  }

  proposeSkill(projectId: string, executionId: string, input: { skillId: string; markdown: string; manifest?: Record<string, unknown>; userId?: string }): { id: string; state: string } {
    if ([input.markdown, json(input.manifest ?? {})].some(containsProposalCredential)) throw new HttpError(422, 'skill_secret_forbidden', 'Skill markdown must not contain credentials');
    return this.transaction(() => {
      const execution = this.loadExecution(projectId, executionId);
      if (!execution) throw new Error('Unknown orchestration execution');
      const skill = this.context.database.prepare('SELECT id FROM skills WHERE id = ? AND (project_id = ? OR project_id IS NULL)').get(input.skillId, projectId) as { id: string } | undefined;
      if (!skill) throw new Error('Unknown skill');
      const id = this.context.ids.id();
      const version = (this.context.database.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS version FROM skill_versions WHERE skill_id = ?').get(input.skillId) as { version: number }).version;
      const markdown = input.markdown.slice(0, 200_000);
      const hash = createHash('sha256').update(markdown).digest('hex');
      this.context.database.prepare('INSERT INTO skill_versions(id, skill_id, version, lifecycle, skill_markdown, manifest_json, content_hash, proposed_by_user_id, created_at) VALUES (?, ?, ?, \'draft\', ?, ?, ?, ?, ?)').run(id, input.skillId, version, markdown, json(input.manifest ?? {}), hash, input.userId ?? null, this.now());
      recordAudit(this.context, {
        projectId,
        actorType: input.userId ? 'user' : 'system',
        ...(input.userId ? { actorId: input.userId } : {}),
        action: 'skill.propose',
        targetType: 'skill_version',
        targetId: id,
        outcome: 'allowed',
        detail: { executionId, skillId: input.skillId, version, contentHash: hash },
      });
      return { id, state: 'draft' };
    });
  }

}

export function createOrchestrationService(context: ServerContext, options?: OrchestrationServiceOptions): OrchestrationService {
  return new OrchestrationService(context, options);
}
