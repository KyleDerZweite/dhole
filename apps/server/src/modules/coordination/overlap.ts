import type { ClaimScope } from '@dhole-control/shared';

/** The smallest useful overlap model shared by the API, orchestration and MCP. */
export interface OverlapClaim {
  id: string;
  coordinationSessionId?: string | null;
  /** New Dhole shape. */
  scope?: ClaimScope;
  /** Flat fields are accepted for Mediation clients during cutover. */
  sessionId?: string | null;
  files?: string[];
  components?: string[];
  task?: string | null;
  intent?: string;
  worktree?: string | null;
  status?: string;
  agent?: string | null;
  developer?: string | null;
  updatedAt?: string;
}

export type OverlapReason =
  | { type: 'files'; detail: Array<{ mine: string; theirs: string }> }
  | { type: 'components'; detail: string[] }
  | { type: 'task'; detail: string[] };

export interface ConflictWarning {
  claimId: string;
  agent?: string | null;
  developer?: string | null;
  intent: string;
  status?: string;
  reasons: OverlapReason[];
  updatedAt?: string;
}

export interface WorkScope extends Omit<ClaimScope, 'task' | 'worktree'> {
  task?: string | null | undefined;
  worktree?: string | null | undefined;
  sessionId?: string | null;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'be',
  'fix', 'bug', 'add', 'update', 'change', 'when', 'that', 'this', 'it', 'from', 'by', 'at', 'as',
  'not', 'no', 'my', 'our',
]);

/** Convert a client path to a stable, relative slash-separated path. */
export function normalizePath(value: string): string {
  const slash = value.replaceAll('\\', '/');
  const parts: string[] = [];
  for (const part of slash.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

function assertSafePath(value: string): void {
  if (value.replaceAll('\\', '/').split('/').some((part) => part === '..')) {
    throw new Error('Paths must not contain parent traversal components');
  }
}

export function tokenize(text: string | null | undefined): Set<string> {
  return new Set((text ?? '').toLocaleLowerCase().split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token)));
}

/** Files overlap on an exact match or when one is a directory prefix of another. */
export function pathsOverlap(left: string, right: string): boolean {
  assertSafePath(left);
  assertSafePath(right);
  const a = normalizePath(left);
  const b = normalizePath(right);
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function filesOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) => right.some((b) => pathsOverlap(a, b)));
}

function sameWorktree(left: string | null | undefined, right: string | null | undefined): boolean {
  return Boolean(left && right && left === right);
}

function scopeOf(claim: OverlapClaim): WorkScope {
  if (claim.scope) return {
    files: claim.scope.files,
    components: claim.scope.components,
    task: claim.scope.task,
    intent: claim.scope.intent,
    worktree: claim.scope.worktree,
  };
  return {
    files: claim.files ?? [],
    components: claim.components ?? [],
    task: claim.task,
    intent: claim.intent ?? '',
    worktree: claim.worktree,
  };
}

/**
 * Explain overlap. Task similarity is deliberately the weakest signal: it only
 * runs when no file/component signal exists and requires two shared tokens.
 */
export function overlapReasons(proposed: WorkScope, existing: OverlapClaim): OverlapReason[] {
  for (const file of proposed.files) assertSafePath(file);
  const reasons: OverlapReason[] = [];
  const existingScope = scopeOf(existing);
  for (const file of existingScope.files) assertSafePath(file);
  const fileHits: Array<{ mine: string; theirs: string }> = [];
  for (const mine of proposed.files) {
    for (const theirs of existingScope.files) {
      if (pathsOverlap(mine, theirs)) fileHits.push({ mine: normalizePath(mine), theirs: normalizePath(theirs) });
    }
  }
  if (fileHits.length) reasons.push({ type: 'files', detail: fileHits });

  const components = new Set(proposed.components.map((component) => component.toLocaleLowerCase()));
  const componentHits = existingScope.components.filter((component) => components.has(component.toLocaleLowerCase()));
  if (componentHits.length) reasons.push({ type: 'components', detail: componentHits });

  if (!reasons.length) {
    const mine = tokenize(`${proposed.task ?? ''} ${proposed.intent}`);
    const theirs = tokenize(`${existingScope.task ?? ''} ${existingScope.intent}`);
    const shared = [...mine].filter((token) => theirs.has(token));
    if (shared.length >= 2) reasons.push({ type: 'task', detail: shared });
  }
  return reasons;
}

/** A reservation can enforce file/component conflicts; task similarity stays advisory. */
export function hasBlockingOverlap(reasons: readonly OverlapReason[]): boolean {
  return reasons.some((reason) => reason.type === 'files' || reason.type === 'components');
}

/** Return warnings for active claims, suppressing same-session and same-worktree noise. */
export function checkOverlap(activeClaims: readonly OverlapClaim[], proposed: WorkScope): ConflictWarning[] {
  for (const file of proposed.files) assertSafePath(file);
  const warnings: ConflictWarning[] = [];
  for (const claim of activeClaims) {
    for (const file of scopeOf(claim).files) assertSafePath(file);
    const sessionId = claim.coordinationSessionId ?? claim.sessionId;
    if (proposed.sessionId && sessionId === proposed.sessionId) continue;
    if (sameWorktree(proposed.worktree, scopeOf(claim).worktree)) continue;
    const reasons = overlapReasons(proposed, claim);
    if (reasons.length) {
      const warning: ConflictWarning = {
        claimId: claim.id,
        intent: scopeOf(claim).intent,
        reasons,
      };
      if (claim.agent !== undefined) warning.agent = claim.agent;
      if (claim.developer !== undefined) warning.developer = claim.developer;
      if (claim.status !== undefined) warning.status = claim.status;
      if (claim.updatedAt !== undefined) warning.updatedAt = claim.updatedAt;
      warnings.push(warning);
    }
  }
  return warnings;
}

export interface PairConflict {
  between: [string, string];
  reasons: OverlapReason[];
}

export function pairConflicts(activeClaims: readonly OverlapClaim[]): PairConflict[] {
  for (const claim of activeClaims) {
    for (const file of scopeOf(claim).files) assertSafePath(file);
  }
  const conflicts: PairConflict[] = [];
  for (let i = 0; i < activeClaims.length; i += 1) {
    const left = activeClaims[i]!;
    for (let j = i + 1; j < activeClaims.length; j += 1) {
      const right = activeClaims[j]!;
      const leftSession = left.coordinationSessionId ?? left.sessionId;
      const rightSession = right.coordinationSessionId ?? right.sessionId;
      if (leftSession && leftSession === rightSession) continue;
      if (sameWorktree(scopeOf(left).worktree, scopeOf(right).worktree)) continue;
      const reasons = overlapReasons({
        files: scopeOf(right).files,
        components: scopeOf(right).components,
        intent: scopeOf(right).intent,
        task: scopeOf(right).task,
        worktree: scopeOf(right).worktree,
      }, left);
      if (reasons.length) conflicts.push({ between: [left.id, right.id], reasons });
    }
  }
  return conflicts;
}
