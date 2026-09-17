#!/usr/bin/env node
/**
 * Deploys an Octavus agent definition to the matching dev or prod slug.
 *
 * Both targets live in the same Octavus environment and are distinguished only
 * by slug. Prompt/protocol files under agents/<name>/ are the source of truth.
 * We never edit them per-environment; instead we stage a copy and rewrite only
 * the identity fields (slug + display name).
 *
 * Usage:
 *   node scripts/deploy-agent.mjs <dev|prod> [--agent cosmo-mail|cosmo-mail-character] [--yes]
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
const BUILD_ROOT = path.join(ROOT, '.agent-build');

const AGENTS = {
  'cosmo-mail': {
    source: 'agents/cosmo-mail',
    prod: { slug: 'cosmo-mail', name: 'Cosmo Mail' },
    dev: { slug: 'cosmo-mail-dev', name: 'Cosmo Mail dev' },
  },
  'cosmo-mail-character': {
    source: 'agents/cosmo-mail-character',
    prod: { slug: 'cosmo-mail-character', name: 'Cosmo Mail Character' },
    dev: { slug: 'cosmo-mail-character-dev', name: 'Cosmo Mail Character dev' },
  },
};

const args = process.argv.slice(2);
const target = args.find((arg) => arg === 'dev' || arg === 'prod');
const autoConfirm = args.includes('--yes') || args.includes('-y');
const agentFlag = args.indexOf('--agent');
const agentKey = agentFlag >= 0 ? args[agentFlag + 1] : 'cosmo-mail';

if (!target || !AGENTS[agentKey]) {
  console.error(
    'Usage: node scripts/deploy-agent.mjs <dev|prod> [--agent cosmo-mail|cosmo-mail-character] [--yes]',
  );
  if (!target) console.error(`Unknown target: ${args[0] ?? '(none)'}`);
  if (!AGENTS[agentKey]) console.error(`Unknown agent: ${agentKey ?? '(none)'}`);
  process.exit(1);
}

const agent = AGENTS[agentKey];
const { slug, name } = agent[target];
const sourceDir = path.join(ROOT, agent.source);

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
  fs.cpSync(sourceDir, stageDir, { recursive: true });

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
  console.log(`Deploying ${agentKey} → "${slug}" (target: ${target})`);
  const stageDir = stageAgent();
  octavus(stageDir, 'validate');
  octavus(stageDir, 'sync');
  console.log(`\n✓ Synced "${slug}" (${target}).`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
