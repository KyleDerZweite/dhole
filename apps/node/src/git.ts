import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFilePromise = promisify(execFile);

export class RepositoryPathError extends Error {
  constructor(message = 'Path is outside the node repository allowlist') {
    super(message);
    this.name = 'RepositoryPathError';
  }
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function assertExistingAncestorInside(root: string, target: string): void {
  let ancestor = target;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new RepositoryPathError();
    ancestor = parent;
  }
  let resolvedAncestor: string;
  try { resolvedAncestor = realpathSync.native(ancestor); } catch { throw new RepositoryPathError(); }
  if (!inside(root, resolvedAncestor)) throw new RepositoryPathError();
}

function safeRemote(remote: string): string {
  try {
    const url = new URL(remote);
    if (!url.username && !url.password) return remote;
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    const at = remote.indexOf('@');
    if (at > 0 && remote.slice(0, at).includes(':')) return remote.slice(at + 1);
    return remote;
  }
}

/** Resolve a repository path and enforce that it is beneath a realpath allowlist root. */
export function assertAllowedPath(candidate: string, allowlist: readonly string[]): string {
  if (!isAbsolute(candidate)) throw new RepositoryPathError('Repository paths must be absolute');
  let resolvedCandidate: string;
  try { resolvedCandidate = realpathSync.native(candidate); } catch { throw new RepositoryPathError('Repository path does not exist'); }
  for (const entry of allowlist) {
    if (!isAbsolute(entry)) continue;
    let root: string;
    try { root = realpathSync.native(entry); } catch { continue; }
    if (inside(root, resolvedCandidate)) return resolvedCandidate;
  }
  throw new RepositoryPathError();
}

export function isAllowedPath(candidate: string, allowlist: readonly string[]): boolean {
  try { assertAllowedPath(candidate, allowlist); return true; } catch { return false; }
}

function validateBranch(branch: string): void {
  if (!branch || branch.startsWith('-') || branch.includes('..') || /[\0\r\n]/.test(branch)) throw new RepositoryPathError('Invalid Git branch name');
}

function validateRelativeTarget(target: string): void {
  if (!target || isAbsolute(target) || target.split(/[\\/]/u).includes('..') || target.includes('\0')) throw new RepositoryPathError('Worktree target must be a safe relative path');
}

function gitArgs(repoRoot: string, args: readonly string[]): string[] {
  return ['-C', repoRoot, ...args];
}

export interface GitWorktree {
  path: string;
  head?: string;
  branch?: string;
  bare?: boolean;
}

export interface RepositoryInfo {
  path: string;
  remote?: string;
  branch?: string;
}

export function listWorktreesSync(repositoryRoot: string, allowlist: readonly string[] = [repositoryRoot]): GitWorktree[] {
  const root = assertAllowedPath(repositoryRoot, allowlist);
  const output = execFileSync('git', gitArgs(root, ['worktree', 'list', '--porcelain']), { encoding: 'utf8', maxBuffer: 1_048_576, windowsHide: true });
  const result: GitWorktree[] = [];
  let current: GitWorktree | undefined;
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith('worktree ')) {
      if (current) result.push(current);
      current = { path: line.slice('worktree '.length) };
    } else if (!current) continue;
    else if (line.startsWith('HEAD ')) current.head = line.slice(5);
    else if (line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//u, '');
    else if (line === 'bare') current.bare = true;
  }
  if (current) result.push(current);
  return result.filter((item) => isAllowedPath(item.path, allowlist));
}

export async function listWorktrees(repositoryRoot: string, allowlist: readonly string[] = [repositoryRoot]): Promise<GitWorktree[]> {
  const root = assertAllowedPath(repositoryRoot, allowlist);
  const { stdout } = await execFilePromise('git', gitArgs(root, ['worktree', 'list', '--porcelain']), { maxBuffer: 1_048_576, windowsHide: true });
  const result: GitWorktree[] = [];
  let current: GitWorktree | undefined;
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.startsWith('worktree ')) { if (current) result.push(current); current = { path: line.slice(9) }; }
    else if (current && line.startsWith('HEAD ')) current.head = line.slice(5);
    else if (current && line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//u, '');
    else if (current && line === 'bare') current.bare = true;
  }
  if (current) result.push(current);
  return result.filter((item) => isAllowedPath(item.path, allowlist));
}

export function createWorktreeSync(repositoryRoot: string, relativeTarget: string, branch: string, allowlist: readonly string[] = [repositoryRoot], baseRevision?: string): string {
  const root = assertAllowedPath(repositoryRoot, allowlist);
  validateRelativeTarget(relativeTarget);
  validateBranch(branch);
  const target = resolve(root, relativeTarget);
  if (!inside(root, target)) throw new RepositoryPathError();
  if (existsSync(target)) throw new RepositoryPathError('Worktree target already exists');
  assertExistingAncestorInside(root, target);
  let args = ['worktree', 'add', target, branch];
  if (baseRevision) {
    validateBranch(baseRevision);
    args = ['worktree', 'add', '-b', branch, target, baseRevision];
  }
  execFileSync('git', gitArgs(root, args), { encoding: 'utf8', maxBuffer: 1_048_576, windowsHide: true });
  return target;
}

export async function createWorktree(repositoryRoot: string, relativeTarget: string, branch: string, allowlist: readonly string[] = [repositoryRoot], baseRevision?: string): Promise<string> {
  const root = assertAllowedPath(repositoryRoot, allowlist);
  validateRelativeTarget(relativeTarget);
  validateBranch(branch);
  const target = resolve(root, relativeTarget);
  if (!inside(root, target)) throw new RepositoryPathError();
  if (existsSync(target)) throw new RepositoryPathError('Worktree target already exists');
  assertExistingAncestorInside(root, target);
  let args = ['worktree', 'add', target, branch];
  if (baseRevision) {
    validateBranch(baseRevision);
    args = ['worktree', 'add', '-b', branch, target, baseRevision];
  }
  await execFilePromise('git', gitArgs(root, args), { maxBuffer: 1_048_576, windowsHide: true });
  return target;
}

export function removeWorktreeSync(repositoryRoot: string, relativeTarget: string, allowlist: readonly string[] = [repositoryRoot]): void {
  const root = assertAllowedPath(repositoryRoot, allowlist);
  validateRelativeTarget(relativeTarget);
  const target = resolve(root, relativeTarget);
  if (!inside(root, target)) throw new RepositoryPathError();
  assertExistingAncestorInside(root, target);
  const targetReal = existsSync(target) ? realpathSync.native(target) : target;
  if (!inside(root, targetReal)) throw new RepositoryPathError();
  execFileSync('git', gitArgs(root, ['worktree', 'remove', '--force', target]), { encoding: 'utf8', maxBuffer: 1_048_576, windowsHide: true });
}

export async function removeWorktree(repositoryRoot: string, relativeTarget: string, allowlist: readonly string[] = [repositoryRoot]): Promise<void> {
  const root = assertAllowedPath(repositoryRoot, allowlist);
  validateRelativeTarget(relativeTarget);
  const target = resolve(root, relativeTarget);
  if (!inside(root, target)) throw new RepositoryPathError();
  assertExistingAncestorInside(root, target);
  const targetReal = existsSync(target) ? realpathSync.native(target) : target;
  if (!inside(root, targetReal)) throw new RepositoryPathError();
  await execFilePromise('git', gitArgs(root, ['worktree', 'remove', '--force', target]), { maxBuffer: 1_048_576, windowsHide: true });
}

export function discoverRepositoriesSync(searchRoots: readonly string[], allowlist: readonly string[] = searchRoots, maxRepositories = 100): RepositoryInfo[] {
  const result: RepositoryInfo[] = [];
  const seen = new Set<string>();
  const visit = (directory: string): void => {
    if (result.length >= maxRepositories || seen.has(directory)) return;
    seen.add(directory);
    let entries: Array<import('node:fs').Dirent<string>>;
    try { entries = readdirSync(directory, { withFileTypes: true, encoding: 'utf8' }) as unknown as Array<import('node:fs').Dirent<string>>; } catch { return; }
    if (entries.some((entry) => entry.name === '.git' && (entry.isDirectory() || entry.isFile()))) {
      try {
        const root = assertAllowedPath(directory, allowlist);
        const branch = execFileSync('git', gitArgs(root, ['branch', '--show-current']), { encoding: 'utf8', windowsHide: true }).trim();
        const remote = execFileSync('git', gitArgs(root, ['config', '--get', 'remote.origin.url']), { encoding: 'utf8', windowsHide: true }).trim();
        result.push({ path: root, ...(branch ? { branch } : {}), ...(remote ? { remote: safeRemote(remote) } : {}) });
      } catch { /* not a usable repository */ }
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) visit(resolve(directory, entry.name));
    }
  };
  for (const root of searchRoots) {
    try { visit(assertAllowedPath(resolve(root), allowlist)); } catch { /* ignore disallowed roots */ }
  }
  return result;
}

export async function discoverRepositories(searchRoots: readonly string[], allowlist: readonly string[] = searchRoots, maxRepositories = 100): Promise<RepositoryInfo[]> {
  return discoverRepositoriesSync(searchRoots, allowlist, maxRepositories);
}

/** Convenience object used by the node command dispatcher. */
export class GitWorkspace {
  constructor(readonly allowlist: readonly string[]) {}
  assertAllowedPath(candidate: string): string { return assertAllowedPath(candidate, this.allowlist); }
  createWorktree(repositoryRoot: string, relativeTarget: string, branch: string, baseRevision?: string): Promise<string> { return createWorktree(repositoryRoot, relativeTarget, branch, this.allowlist, baseRevision); }
  removeWorktree(repositoryRoot: string, relativeTarget: string): Promise<void> { return removeWorktree(repositoryRoot, relativeTarget, this.allowlist); }
  listWorktrees(repositoryRoot: string): Promise<GitWorktree[]> { return listWorktrees(repositoryRoot, this.allowlist); }
  discoverRepositories(): Promise<RepositoryInfo[]> { return discoverRepositories(this.allowlist, this.allowlist); }
}

export const canonicalRepositoryPath = assertAllowedPath;
