#!/usr/bin/env node
// Compile every Bicep template to ARM JSON, then run the security-policy assertions against the
// compiled output.
//
// The compile step is what `az bicep build` gives us; the point of doing it here is that the JSON
// it produces is the artefact tests/infra/policy.test.ts inspects. "Storage is private" is then a
// property of the thing that will actually be deployed, not of a comment.

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const infra = path.join(root, 'infra');
const outDir = path.join(root, 'infra', '.build');

const templates = ['foundation.bicep', 'app.bicep'];

/** `az` is a batch file on Windows, so it is invoked as a single shell command line. */
const AZ = process.platform === 'win32' ? 'az.cmd' : 'az';

const az = (command) => spawnSync(`${AZ} ${command}`, { stdio: 'inherit', shell: true });

const probe = az('bicep version');
if (probe.error !== undefined || probe.status !== 0) {
  console.error(
    [
      '',
      'Azure CLI with the Bicep extension is required to compile the infrastructure.',
      '',
      '  Install the CLI:   https://learn.microsoft.com/cli/azure/install-azure-cli',
      '  Install Bicep:     az bicep install',
      '',
      'No Azure subscription, login or credential is needed — this only compiles templates.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const template of templates) {
  const source = path.join(infra, template);
  const target = path.join(outDir, template.replace(/\.bicep$/u, '.json'));
  console.log(`bicep build ${template}`);
  const result = az(`bicep build --file "${source}" --outfile "${target}"`);
  if (result.status !== 0) {
    console.error(`bicep build failed for ${template}`);
    process.exit(result.status ?? 1);
  }
}

console.log('\nrunning infrastructure policy assertions\n');
const vitest = spawnSync('npx vitest run --project infra', {
  stdio: 'inherit',
  cwd: root,
  shell: true,
});
process.exit(vitest.status ?? 1);
