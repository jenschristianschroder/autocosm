#!/usr/bin/env node
/**
 * Scan every file that git would track for credentials that must never be committed.
 *
 * This is a guard, not a substitute for the real invariant: production code refuses shared keys
 * and connection strings outright (see packages/storage/src/guardrails.ts). The scan exists so a
 * copy-pasted Azure connection string cannot reach a commit unnoticed.
 *
 * Known-safe matches are allow-listed by file, because the guardrail module necessarily contains
 * the very substrings it detects.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

/** Each pattern is a credential shape that has no legitimate reason to appear in source. */
const PATTERNS = [
  { name: 'storage account key', re: /AccountKey\s*=/iu },
  { name: 'storage connection string', re: /DefaultEndpointsProtocol\s*=/iu },
  { name: 'SAS token', re: /SharedAccessSignature|[?&]sv=20\d\d-\d\d-\d\d/iu },
  { name: 'SAS signature', re: /[?&]sig=[A-Za-z0-9%+/]{20,}/u },
  { name: 'private key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u },
  { name: 'client secret', re: /AZURE_CLIENT_SECRET\s*[:=]\s*\S/u },
  { name: 'inline api key', re: /(?:api[_-]?key|apikey)\s*[:=]\s*["'][A-Za-z0-9_-]{16,}["']/iu },
  { name: 'bearer literal', re: /Bearer\s+[A-Za-z0-9_-]{30,}\./u },
];

/**
 * Files permitted to contain a credential-shaped string.
 *
 * Every entry is a place whose *purpose* is to detect or reject the shape, so the shape has to
 * appear literally. Nothing here is a usable credential: the storage keys are `Zm9vYmFy`
 * (base64 `foobar`) and the single letter `b`.
 */
const ALLOWED = new Set([
  // Defines SECRET_PATTERNS — the log redactor's own detection regexes.
  'packages/observability/src/logger.ts',
  // Proves the redactor replaces a connection string and a SAS URL with [redacted].
  'packages/observability/src/observability.test.ts',
  // Defines the production storage guardrail.
  'packages/storage/src/guardrails.ts',
  // Proves the guardrail throws on a connection string and on a SAS-bearing endpoint.
  'packages/storage/src/storage-contract.test.ts',
  // Documents the forbidden shapes so an operator recognises one.
  'docs/security.md',
  // This scanner's own pattern table.
  'scripts/scan-secrets.mjs',
]);

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
})
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

const findings = [];
let scanned = 0;

for (const file of files) {
  let stats;
  try {
    stats = statSync(file);
  } catch {
    continue; // Deleted between listing and reading.
  }
  if (!stats.isFile() || stats.size > 4 * 1024 * 1024) continue;

  const text = readFileSync(file, 'utf8');
  if (text.includes('\u0000')) continue; // Binary.
  scanned += 1;

  const normalised = file.replaceAll('\\', '/');
  if (ALLOWED.has(normalised)) continue;

  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    for (const pattern of PATTERNS) {
      if (pattern.re.test(line)) {
        findings.push({ file: normalised, line: index + 1, kind: pattern.name });
      }
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(`secret scan FAILED — ${findings.length} finding(s)\n`);
  for (const finding of findings) {
    process.stderr.write(`  ${finding.file}:${finding.line}  ${finding.kind}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `secret scan clean — ${scanned} file(s) scanned, ${ALLOWED.size} allow-listed\n`,
);
