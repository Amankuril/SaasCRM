// Starts the API and the web app together with prefixed output.
// Dependency-free on purpose: the repo root has no node_modules.
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const apps = [
  { name: 'api', dir: 'backend', color: '\x1b[36m' },
  { name: 'web', dir: 'frontend', color: '\x1b[35m' },
];

const children = apps.map(({ name, dir, color }) => {
  const child = spawn(npm, ['--prefix', dir, 'run', 'dev'], { stdio: ['inherit', 'pipe', 'pipe'], env: process.env });
  const prefix = `${color}[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    console.log(`${prefix}exited with code ${code}`);
    shutdown(code ?? 0);
  });
  return child;
});

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
