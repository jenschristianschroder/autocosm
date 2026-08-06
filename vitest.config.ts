import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

/**
 * Tests run against workspace *sources*, not built `dist` output, so a test run never
 * depends on build ordering. `npm run typecheck` and `npm run build` cover the emitted
 * artefacts separately.
 */
const alias = {
  '@autocosm/domain': pkg('domain'),
  '@autocosm/simulation': pkg('simulation'),
  '@autocosm/storage': pkg('storage'),
  '@autocosm/agent-runtime': pkg('agent-runtime'),
  '@autocosm/observability': pkg('observability'),
};

const project = (name: string, root: string) => ({
  resolve: { alias },
  test: {
    name,
    root: fileURLToPath(new URL(root, import.meta.url)),
    include: ['**/*.test.ts'],
    environment: 'node' as const,
  },
});

export default defineConfig({
  test: {
    projects: [
      project('domain', './packages/domain'),
      project('simulation', './packages/simulation'),
      project('storage', './packages/storage'),
      project('agent-runtime', './packages/agent-runtime'),
      project('observability', './packages/observability'),
      project('world-web', './apps/world-web'),
      project('world-tick', './apps/world-tick'),
      project('agent-think', './apps/agent-think'),
      project('world-admin', './apps/world-admin'),
      project('web-client', './apps/web-client'),
      project('infra', './tests/infra'),
    ],
  },
});
