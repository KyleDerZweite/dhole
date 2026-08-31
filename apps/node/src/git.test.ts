import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RepositoryPathError, createWorktreeSync, discoverRepositoriesSync, listWorktreesSync, removeWorktreeSync } from './git.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('Git workspace allowlists', () => {
  it('creates/removes a temporary worktree and rejects traversal', () => {
    const root = mkdtempSync(join(tmpdir(), 'dhole-git-'));
    directories.push(root);
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Dhole Test']);
    writeFileSync(join(root, 'README.md'), 'fixture\n');
    execFileSync('git', ['-C', root, 'add', 'README.md']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'initial']);
    execFileSync('git', ['-C', root, 'branch', 'fixture']);
    expect(() => createWorktreeSync(root, '../escape', 'fixture', [root])).toThrow(RepositoryPathError);
    const worktree = createWorktreeSync(root, 'tmp/worktree', 'fixture', [root]);
    expect(worktree).toContain(join(root, 'tmp/worktree'));
    removeWorktreeSync(root, 'tmp/worktree', [root]);
    const isolated = createWorktreeSync(root, 'tmp/isolated', 'dhole/isolated', [root], 'HEAD');
    expect(isolated).toContain(join(root, 'tmp/isolated'));
    expect(execFileSync('git', ['-C', root, 'branch', '--list', 'dhole/isolated'], { encoding: 'utf8' }).trim()).toContain('dhole/isolated');
    removeWorktreeSync(root, 'tmp/isolated', [root]);
  });

  it('rejects a worktree target beneath a symlink that escapes the root', () => {
    const root = mkdtempSync(join(tmpdir(), 'dhole-git-'));
    const outside = mkdtempSync(join(tmpdir(), 'dhole-git-outside-'));
    directories.push(root, outside);
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Dhole Test']);
    writeFileSync(join(root, 'README.md'), 'fixture\n');
    execFileSync('git', ['-C', root, 'add', 'README.md']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'initial']);
    execFileSync('git', ['-C', root, 'branch', 'fixture']);
    symlinkSync(outside, join(root, 'escape'));
    expect(() => createWorktreeSync(root, 'escape/worktree', 'fixture', [root])).toThrow(RepositoryPathError);
  });

  it('does not report Git worktrees outside the configured allowlist', () => {
    const root = mkdtempSync(join(tmpdir(), 'dhole-git-'));
    const outside = mkdtempSync(join(tmpdir(), 'dhole-git-outside-'));
    directories.push(root, outside);
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Dhole Test']);
    writeFileSync(join(root, 'README.md'), 'fixture\n');
    execFileSync('git', ['-C', root, 'add', 'README.md']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'initial']);
    execFileSync('git', ['-C', root, 'branch', 'external']);
    execFileSync('git', ['-C', root, 'worktree', 'add', join(outside, 'worktree'), 'external']);
    expect(listWorktreesSync(root, [root]).map((worktree) => worktree.path)).toEqual([realpathSync.native(root)]);
  });

  it('redacts credentials from discovered Git remote URLs', () => {
    const root = mkdtempSync(join(tmpdir(), 'dhole-git-'));
    directories.push(root);
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Dhole Test']);
    writeFileSync(join(root, 'README.md'), 'fixture\n');
    execFileSync('git', ['-C', root, 'add', 'README.md']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'initial']);
    execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://user:password@example.invalid/org/repo.git']);
    expect(discoverRepositoriesSync([root], [root])[0]?.remote).toBe('https://example.invalid/org/repo.git');
  });
});
