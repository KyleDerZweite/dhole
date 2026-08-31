import { spawn } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;

function run(command, args, options = {}) {
  return spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
}

const build = run('pnpm', ['build']);
const exitCode = await new Promise((resolve) => build.once('exit', (code) => resolve(code ?? 1)));
if (exitCode !== 0) process.exit(exitCode);

const server = run(process.execPath, ['apps/server/dist/index.js']);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.kill(signal));
process.exitCode = await new Promise((resolve) => server.once('exit', (code) => resolve(code ?? 1)));
