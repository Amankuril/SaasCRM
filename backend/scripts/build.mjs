// Production build: transpile src/ to dist/ with esbuild (no type-check).
// One output file per source file, so `node dist/server.js` works exactly as
// with tsc. Type errors are caught by `npm run typecheck` before pushing;
// a full tsc pass is too slow and memory-hungry for a small server.
import { build } from 'esbuild';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [path] : [];
  });
}

const started = Date.now();
rmSync('dist', { recursive: true, force: true });
const entryPoints = sources('src');
await build({
  entryPoints,
  outdir: 'dist',
  outbase: 'src',
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'warning',
});
console.log(`Built ${entryPoints.length} files to dist/ in ${Date.now() - started} ms`);
