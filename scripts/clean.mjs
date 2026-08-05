#!/usr/bin/env node
/**
 * Remove build output without touching node_modules or anything untracked that a developer cares
 * about. Deliberately conservative: it only deletes paths this repository is known to generate.
 */
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const targets = [
  'packages/domain/dist',
  'packages/simulation/dist',
  'packages/storage/dist',
  'packages/agent-runtime/dist',
  'packages/observability/dist',
  'apps/world-web/dist',
  'apps/world-web/public',
  'apps/world-tick/dist',
  'apps/agent-think/dist',
  'apps/web-client/dist',
  'coverage',
  'test-results',
  'playwright-report',
  'blob-report',
  'infra/out',
];

const buildInfo = [
  'tsconfig.build.tsbuildinfo',
  'packages/domain/tsconfig.tsbuildinfo',
  'packages/simulation/tsconfig.tsbuildinfo',
  'packages/storage/tsconfig.tsbuildinfo',
  'packages/agent-runtime/tsconfig.tsbuildinfo',
  'packages/observability/tsconfig.tsbuildinfo',
  'apps/world-web/tsconfig.tsbuildinfo',
  'apps/world-tick/tsconfig.tsbuildinfo',
  'apps/agent-think/tsconfig.tsbuildinfo',
  'apps/web-client/tsconfig.app.tsbuildinfo',
];

for (const target of [...targets, ...buildInfo]) {
  await rm(path.join(root, target), { recursive: true, force: true });
}

console.log(`cleaned ${targets.length + buildInfo.length} build artefacts`);
