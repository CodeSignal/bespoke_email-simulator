#!/usr/bin/env node
/**
 * Deploys the cosmo-mail agent definition to the dev or prod Octavus agent.
 *
 * Both targets live in the same Octavus environment and are distinguished only
 * by slug:
 *   - prod -> "cosmo-mail"      (agent the real users hit)
 *   - dev  -> "cosmo-mail-dev"  (scratch agent for local testing)
 *
 * The prompt/protocol files under agents/cosmo-mail/ are the single source of
 * truth. We never edit them per-environment; instead we stage a copy and rewrite
 * only the identity fields (slug + display name) so the two agents can never
 * silently drift apart.
 *
 * Usage:
 *   node scripts/deploy-agent.mjs dev
 *   node scripts/deploy-agent.mjs prod [--yes]
 *
 * Prod requires an explicit confirmation: either pass --yes (for CI) or answer
 * the interactive prompt.
 */

import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'agents', 'cosmo-mail');
const BUILD_ROOT = path.join(ROOT, '.agent-build');

const TARGETS = {
  prod: { slug: 'cosmo-mail', name: 'Cosmo Mail' },
  dev: { slug: 'cosmo-mail-dev', name: 'Cosmo Mail dev' },
};

const args = process.argv.slice(2);
const target = args[0];
const autoConfirm = args.includes('--yes') || args.includes('-y');

if (!TARGETS[target]) {
  console.error('Usage: node scripts/deploy-agent.mjs <dev|prod> [--yes]');
  console.error(`Unknown target: ${target ?? '(none)'}`);
  process.exit(1);
}

const { slug, name } = TARGETS[target];

async function confirmProd() {
  if (target !== 'prod' || autoConfirm) return;
  if (!stdin.isTTY) {
    console.error(
      'Refusing to deploy to PROD without confirmation. Re-run with --yes (e.g. in CI).',
    );
    process.exit(1);
  }
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(
    `You are about to deploy to PROD agent "${slug}". Type "deploy" to continue: `,
  );
  rl.close();
  if (answer.trim() !== 'deploy') {
    console.error('Aborted.');
    process.exit(1);
  }
}

function stageAgent() {
  const stageDir = path.join(BUILD_ROOT, slug);
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(BUILD_ROOT, { recursive: true });
  fs.cpSync(SOURCE_DIR, stageDir, { recursive: true });

  // Rewrite only the identity fields; everything else is copied verbatim.
  const settingsPath = path.join(stageDir, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  settings.slug = slug;
  settings.name = name;
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

  return stageDir;
}

function octavus(stageDir, command) {
  console.log(`\n> octavus ${command} ${stageDir}`);
  execFileSync('npx', ['octavus', '--env', '.env', command, stageDir], {
    stdio: 'inherit',
    cwd: ROOT,
  });
}

async function main() {
  await confirmProd();
  console.log(`Deploying cosmo-mail → "${slug}" (target: ${target})`);
  const stageDir = stageAgent();
  octavus(stageDir, 'validate');
  octavus(stageDir, 'sync');
  console.log(`\n✓ Synced "${slug}" (${target}).`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
