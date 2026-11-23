// Development: recompile on change and restart the API.
import { spawn } from 'node:child_process';

const opts = { stdio: 'inherit', shell: process.platform === 'win32' };
const tsc = spawn('npx', ['tsc', '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'], opts);
// Give the first compile a head start, then run with Node's watch mode.
setTimeout(() => {
  const api = spawn('node', ['--watch', '--enable-source-maps', 'dist/src/main.js'], opts);
  api.on('exit', (code) => process.exit(code ?? 0));
}, 6000);

const stop = () => {
  tsc.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
