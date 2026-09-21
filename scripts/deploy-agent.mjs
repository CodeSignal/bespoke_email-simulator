#!/usr/bin/env node
/**
 * Deploys CosmoMail agent definitions to the matching dev or prod slugs.
 *
 * Both targets live in the same Octavus environment and are distinguished only
 * by slug. Prompt/protocol files under agents/<name>/ are the source of truth.
 * We never edit them per-environment; instead we stage a copy and rewrite only
 * the identity fields (slug + display name).
 *
 * Usage:
 *   node scripts/deploy-agent.mjs [dev|prod] [--agent <name>] [--yes]
 *
 * If the target is omitted, AGENT_TARGET from .env is used (defaults to prod).
 * If --agent is omitted, both cosmo-mail and cosmo-mail-character are deployed.
 *
 * Prod requires an explicit confirmation: either pass --yes (for CI) or answer
 * the interactive prompt.
 */

import dotenv from 'dotenv';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BUILD_ROOT = path.join(ROOT, '.agent-build');

export const AGENTS = {
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

export function resolveTarget(args, envTarget) {
  const agentFlag = args.indexOf('--agent');
  const positional = args.find((arg, i) => {
    if (arg.startsWith('-')) return false;
    if (agentFlag >= 0 && i === agentFlag + 1) return false;
    return true;
  });
  if (positional) {
    const target = positional.toLowerCase();
    if (target !== 'dev' && target !== 'prod') {
      throw new Error(`Unknown target: ${positional}. Expected "prod" or "dev".`);
    }
    return target;
  }
  const target = (envTarget ?? 'prod').toLowerCase();
  if (target !== 'dev' && target !== 'prod') {
    throw new Error(`Invalid AGENT_TARGET "${envTarget}". Expected "prod" or "dev".`);
  }
  return target;
}

export function resolveAgentKeys(args) {
  const agentFlag = args.indexOf('--agent');
  if (agentFlag < 0) return Object.keys(AGENTS);
  const agentKey = args[agentFlag + 1];
  if (!AGENTS[agentKey]) {
    throw new Error(
      `Unknown agent: ${agentKey ?? '(none)'}. Expected ${Object.keys(AGENTS).join(' or ')}.`,
    );
  }
  return [agentKey];
}

export function rewriteSettings(settings, identity) {
  return { ...settings, slug: identity.slug, name: identity.name };
}

function usageAndExit(message) {
  if (message) console.error(message);
  console.error(
    'Usage: node scripts/deploy-agent.mjs [dev|prod] [--agent cosmo-mail|cosmo-mail-character] [--yes]',
  );
  process.exit(1);
}

async function confirmProd(target, identities, autoConfirm) {
  if (target !== 'prod' || autoConfirm) return;
  const slugs = identities.map((id) => `"${id.slug}"`).join(' and ');
  if (!stdin.isTTY) {
    console.error(
      'Refusing to deploy to PROD without confirmation. Re-run with --yes (e.g. in CI).',
    );
    process.exit(1);
  }
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(
    `You are about to deploy to PROD agent${identities.length > 1 ? 's' : ''} ${slugs}. Type "deploy" to continue: `,
  );
  rl.close();
  if (answer.trim() !== 'deploy') {
    console.error('Aborted.');
    process.exit(1);
  }
}

function stageAgent(agentKey, identity) {
  const sourceDir = path.join(ROOT, AGENTS[agentKey].source);
  const stageDir = path.join(BUILD_ROOT, identity.slug);
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(BUILD_ROOT, { recursive: true });
  fs.cpSync(sourceDir, stageDir, { recursive: true });

  const settingsPath = path.join(stageDir, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  fs.writeFileSync(
    settingsPath,
    `${JSON.stringify(rewriteSettings(settings, identity), null, 2)}\n`,
  );

  return stageDir;
}

function octavus(stageDir, command) {
  console.log(`\n> octavus ${command} ${stageDir}`);
  execFileSync('npx', ['octavus', '--env', '.env', command, stageDir], {
    stdio: 'inherit',
    cwd: ROOT,
  });
}

export async function main(argv = process.argv.slice(2)) {
  let target;
  let agentKeys;
  try {
    target = resolveTarget(argv, process.env.AGENT_TARGET);
    agentKeys = resolveAgentKeys(argv);
  } catch (err) {
    usageAndExit(err instanceof Error ? err.message : String(err));
    return;
  }

  const autoConfirm = argv.includes('--yes') || argv.includes('-y');
  const identities = agentKeys.map((key) => ({ key, ...AGENTS[key][target] }));

  await confirmProd(target, identities, autoConfirm);

  for (const identity of identities) {
    console.log(`Deploying ${identity.key} → "${identity.slug}" (target: ${target})`);
    const stageDir = stageAgent(identity.key, identity);
    octavus(stageDir, 'validate');
    octavus(stageDir, 'sync');
    console.log(`\n✓ Synced "${identity.slug}" (${target}).`);
  }
}

const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  dotenv.config();
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
