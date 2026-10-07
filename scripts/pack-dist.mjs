#!/usr/bin/env node
/**
 * Builds a runnable release tree into dist/ and archives it as dist.tar.gz.
 *
 * The tarball is the client bundle + a single-file server bundle + the static
 * files Express serves. No node_modules. Extract and `node server.js`.
 *
 * Usage:
 *   node scripts/pack-dist.mjs
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const TAR = path.join(ROOT, 'dist.tar.gz');

function copy(src, dest, filter) {
  fs.cpSync(src, dest, { recursive: true, filter });
}

function bytes(file) {
  return fs.statSync(file).size;
}

function formatSize(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function distSize(rel) {
  const full = path.join(DIST, rel);
  if (!fs.existsSync(full)) return 0;
  const st = fs.statSync(full);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const child = path.join(rel, entry.name);
    total += distSize(child);
  }
  return total;
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, 'public'), { recursive: true });

await esbuild.build({
  absWorkingDir: ROOT,
  entryPoints: ['public/app.js'],
  bundle: true,
  outfile: 'dist/public/app.bundle.js',
  format: 'esm',
  platform: 'browser',
  minify: true,
  logLevel: 'warning',
});

await esbuild.build({
  absWorkingDir: ROOT,
  entryPoints: ['server.js'],
  bundle: true,
  outfile: 'dist/server.js',
  format: 'esm',
  platform: 'node',
  minify: true,
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'warning',
});

await esbuild.build({
  absWorkingDir: ROOT,
  entryPoints: ['extract-conversations.js'],
  bundle: true,
  outfile: 'dist/extract-conversations.js',
  format: 'esm',
  platform: 'node',
  minify: true,
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'warning',
});

// Everything Express serves from public/, except the unbundled source and a
// local app.bundle.js (esbuild already wrote the minified one into dist/).
const publicSrc = path.join(ROOT, 'public');
copy(publicSrc, path.join(DIST, 'public'), (src) => {
  const base = path.basename(src);
  if (base === '.DS_Store') return false;
  if (src === publicSrc) return true;
  return base !== 'app.js' && base !== 'app.bundle.js';
});
// Packed releases have no node_modules. Dev serves this from the Rive package;
// the release serves it from public/ via express.static.
copy(
  path.join(ROOT, 'node_modules/@rive-app/canvas/rive.wasm'),
  path.join(DIST, 'public/vendor/rive.wasm'),
);
copy(path.join(ROOT, 'design-system'), path.join(DIST, 'design-system'), (src) => {
  const rel = path.relative(path.join(ROOT, 'design-system'), src);
  return !rel.split(path.sep).includes('.git');
});
copy(path.join(ROOT, 'i18n'), path.join(DIST, 'i18n'));
copy(path.join(ROOT, 'current-models.txt'), path.join(DIST, 'current-models.txt'));
copy(path.join(ROOT, '.env.example'), path.join(DIST, '.env.example'));
copy(path.join(ROOT, 'scenario.example.json'), path.join(DIST, 'scenario.example.json'));

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
fs.writeFileSync(
  path.join(DIST, 'package.json'),
  `${JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      private: true,
      type: 'module',
      scripts: {
        start: 'node server.js',
        extract: 'node extract-conversations.js',
        report: 'node extract-conversations.js --mode report --print-settings',
        'report:chronological':
          'node extract-conversations.js --mode report --print-settings --order chronological',
      },
    },
    null,
    2,
  )}\n`,
);

for (const rel of [
  'public/app.bundle.js',
  'public/app.css',
  'public/global.css',
  'public/index.html',
  'public/animations/thinking.riv',
  'public/icons/mail-logo.svg',
  'public/vendor/rive.wasm',
  'server.js',
  'extract-conversations.js',
]) {
  if (!fs.existsSync(path.join(DIST, rel))) throw new Error(`missing ${rel} in dist/`);
}

process.env.NODE_ENV = 'test';
process.env.SCENARIO_FILE = path.join(DIST, 'scenario.example.json');
process.env.SESSIONS_FILE = path.join(DIST, '.pack-sessions.json');
const { app } = await import(pathToFileURL(path.join(DIST, 'server.js')).href);
const server = await new Promise((resolve, reject) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
  s.on('error', reject);
});
try {
  const port = server.address().port;
  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  if (!health.ok) throw new Error(`health check failed (${health.status})`);
  await health.json();
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(process.env.SESSIONS_FILE, { force: true });
}

if (fs.existsSync(TAR)) fs.unlinkSync(TAR);
execFileSync('tar', ['-czf', TAR, '-C', DIST, '.'], { cwd: ROOT });

const entries = [
  'server.js',
  'extract-conversations.js',
  'public/app.bundle.js',
  'public',
  'design-system',
  'i18n',
];
console.log('Packed dist/ (no node_modules):');
for (const rel of entries) {
  console.log(`  ${rel.padEnd(24)} ${formatSize(distSize(rel))}`);
}
console.log(`  ${'dist.tar.gz'.padEnd(24)} ${formatSize(bytes(TAR))}`);
