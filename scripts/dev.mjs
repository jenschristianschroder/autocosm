#!/usr/bin/env node
/**
 * Local development: `npm run dev`.
 *
 * Compiles the workspaces, then starts two processes:
 *   - `scripts/dev-world.mjs` — world-web plus a real tick loop over one shared in-memory store;
 *   - Vite — serves the browser client on :5173 and proxies `/api` to :8080.
 *
 * No Azure account, no Azurite, no credentials. Stop with Ctrl-C.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';

/** Must match the Vite dev server port in `apps/web-client/vite.config.ts`. */
const CLIENT_URL = 'http://127.0.0.1:5173';

const children = [];
let shuttingDown = false;

/**
 * A Windows shell concatenates arguments instead of escaping them, and on a default install both
 * Node and npm live under `C:\Program Files`. So every shell argument is quoted by hand rather
 * than passed as an array alongside `shell: true`, which is unescaped and deprecated (DEP0190).
 */
const quote = (value) => (/[\s&|<>^"]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

/** `npm.cmd` is a batch file, so only Windows needs a shell to launch it. */
function spawnNpm(args, options) {
  return isWindows
    ? spawn([npm, ...args].map(quote).join(' '), { ...options, shell: true })
    : spawn(npm, args, options);
}

/**
 * On Windows the shell that launched a child is the process we hold; killing it orphans the real
 * program and leaves its port bound. Kill the whole tree instead.
 */
function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (isWindows && child.pid !== undefined) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on(
      'error',
      () => child.kill('SIGTERM'),
    );
    return;
  }
  child.kill('SIGTERM');
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) stop(child);
  setTimeout(() => process.exit(code), 500).unref();
}

function track(name, child) {
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`\n[dev] ${name} exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`);
    shutdown(code ?? 1);
  });
  child.on('error', (error) => {
    if (shuttingDown) return;
    console.error(`\n[dev] ${name} could not start: ${error.message}`);
    shutdown(1);
  });
  children.push({ name, child });
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(0));

console.log('[dev] compiling workspaces…');
const build = spawnNpm(['run', 'typecheck'], { cwd: root, stdio: 'inherit' });

build.on('error', (error) => {
  console.error(`[dev] could not run npm: ${error.message}`);
  process.exit(1);
});

build.on('exit', (code) => {
  if (code !== 0) {
    console.error('[dev] typecheck failed; not starting');
    process.exit(code ?? 1);
    return;
  }

  // Spawned without a shell, so a Node path containing a space needs no quoting at all.
  track(
    'world',
    spawn(process.execPath, [path.join(root, 'scripts', 'dev-world.mjs')], {
      cwd: root,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env,
        NODE_ENV: 'development',
        AUTOCOSM_STORAGE_DRIVER: process.env['AUTOCOSM_STORAGE_DRIVER'] ?? 'memory',
        AUTOCOSM_ALLOW_LOCAL_SEEDING: 'true',
        // Vite serves the client during development, so world-web must not also try to.
        AUTOCOSM_STATIC_ROOT: '',
        // Lets the API-only root path point a stray browser at the real client instead of 404ing.
        AUTOCOSM_DEV_CLIENT_URL: CLIENT_URL,
      },
    }),
  );

  track(
    'client',
    spawnNpm(['run', 'dev', '-w', '@autocosm/web-client'], {
      cwd: root,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
    }),
  );

  console.log(`[dev] open ${CLIENT_URL}`);
});
