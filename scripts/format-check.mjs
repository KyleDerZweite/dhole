import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const ignored = new Set(['.git', 'coverage', 'data', 'dist', 'node_modules']);
const checkedExtensions = new Set(['.css', '.html', '.js', '.json', '.md', '.mjs', '.sql', '.svelte', '.ts', '.yaml', '.yml']);
const failures = [];

function visit(directory) {
  for (const name of readdirSync(directory)) {
    if (ignored.has(name)) continue;
    const path = join(directory, name);
    const stat = statSync(path);
    if (stat.isDirectory()) visit(path);
    else if (checkedExtensions.has(extname(name)) || name === '.gitignore' || name === '.npmrc') check(path);
  }
}

function check(path) {
  const content = readFileSync(path, 'utf8');
  const label = relative(root, path);
  if (content.includes('\r')) failures.push(`${label}: contains CRLF characters`);
  if (content.length > 0 && !content.endsWith('\n')) failures.push(`${label}: missing final newline`);
  content.split('\n').forEach((line, index) => {
    if (/\s+$/.test(line)) failures.push(`${label}:${index + 1}: trailing whitespace`);
  });
}

visit(root);
if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exitCode = 1;
}
