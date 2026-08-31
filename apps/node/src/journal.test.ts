import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OperationJournal } from './journal.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('operation journal', () => {
  it('persists transitions atomically with private file permissions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dhole-journal-'));
    directories.push(directory);
    const path = join(directory, 'journal.json');
    const journal = new OperationJournal(path);
    journal.accept('operation-12345678', 'command-1');
    journal.markRunning('operation-12345678');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8')).operations['operation-12345678'].state).toBe('running');
    journal.complete('operation-12345678', { ok: true });
    expect(new OperationJournal(path).get('operation-12345678')?.state).toBe('completed');
  });

  it('reconciles duplicate operations without creating a second entry', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dhole-journal-'));
    directories.push(directory);
    const journal = new OperationJournal(join(directory, 'journal.json'));
    const first = journal.accept('operation-12345678', 'command-1');
    const duplicate = journal.accept('operation-12345678', 'command-2');
    expect(duplicate).toEqual(first);
    expect(journal.list()).toHaveLength(1);
  });

  it('marks accepted and running operations uncertain after a daemon restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dhole-journal-'));
    directories.push(directory);
    const path = join(directory, 'journal.json');
    const journal = new OperationJournal(path);
    journal.accept('operation-accepted', 'command-accepted');
    journal.accept('operation-running', 'command-running');
    journal.markRunning('operation-running');

    const restarted = new OperationJournal(path);
    expect(restarted.get('operation-accepted')).toMatchObject({
      state: 'uncertain',
      error: 'Operation outcome is uncertain after node restart',
    });
    expect(restarted.get('operation-running')).toMatchObject({
      state: 'uncertain',
      error: 'Operation outcome is uncertain after node restart',
    });
    expect(new OperationJournal(path).list().every((operation) => operation.state === 'uncertain')).toBe(true);
  });

  it('bounds terminal history while retaining nonterminal entries across reload', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dhole-journal-'));
    directories.push(directory);
    const path = join(directory, 'journal.json');
    const journal = new OperationJournal(path);
    journal.accept('operation-pending', 'command-pending');
    for (let index = 0; index < 1_005; index += 1) {
      const key = `operation-terminal-${index}`;
      journal.accept(key, `command-terminal-${index}`);
      journal.complete(key, { index });
    }
    const reloaded = new OperationJournal(path);
    expect(reloaded.get('operation-pending')?.state).toBe('uncertain');
    expect(reloaded.get('operation-terminal-0')).toBeUndefined();
    expect(reloaded.get('operation-terminal-1004')?.state).toBe('completed');
    expect(reloaded.list().filter((operation) => operation.state === 'completed')).toHaveLength(1_000);
  }, 20_000);
});
