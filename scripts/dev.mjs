// runs the server (restarting on changes) and the vite dev server together
import { spawn } from 'node:child_process';

const run = (cmd, args) => spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
const children = [run('pnpm', ['exec', 'tsx', 'watch', 'server/index.ts']), run('pnpm', ['exec', 'vite'])];
const stop = () => children.forEach((child) => child.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children) child.on('exit', (code) => { stop(); process.exit(code ?? 0); });
