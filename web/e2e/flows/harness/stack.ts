// Starts the whole application the way it runs in Azure, on one machine, for the full-flow tests:
//
//   Azurite (Table Storage, in memory, so every run starts with empty tables)
//   the Functions host running the built API bundle (api/dist/bundle.js)
//   a stub of the RIPE Atlas API (ripe-stub.ts), which the API reaches through ATLAS_API_BASE
//   the Static Web Apps CLI emulator serving web/dist, with its mock /.auth/login/<provider>
//
// Playwright starts this as its web server (playwright.flows.config.ts) and stops it with SIGTERM.
// It can also be run on its own to poke at the stack by hand: `npm run e2e:stack -w web`.
//
// It needs `npm run build` to have run, and Azure Functions Core Tools v4: `func` on PATH, or its
// path in FUNC.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startRipeStub } from './ripe-stub';
import { FUNC_URL, LOGS, PORTS, REPO_DIR, RIPE_STUB_URL, STACK_DIR, TABLES_CONNECTION_STRING } from './env';

const children: ChildProcess[] = [];
let stopping = false;

function fail(message: string): never {
  console.error(`[e2e stack] ${message}`);
  stop(1);
  throw new Error(message);
}

function stop(code = 0): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.pid === undefined || child.exitCode !== null) continue;
    try {
      // Each child leads its own process group, so this reaches the processes it started too
      // (the Functions host starts a Node worker).
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
  setTimeout(() => process.exit(code), 500).unref();
}

process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));

function start(name: keyof typeof LOGS, command: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): ChildProcess {
  const log = createWriteStream(LOGS[name]);
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  child.on('error', (err) => fail(`${name} did not start: ${err.message}`));
  child.on('exit', (code, signal) => {
    if (!stopping) fail(`${name} exited (${signal ?? code}); see ${LOGS[name]}`);
  });
  children.push(child);
  return child;
}

async function waitFor(what: string, url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(`${what} was not ready at ${url} after ${timeoutMs / 1000} s`);
}

/** Fail early, and say why, when a port is taken: the emulator would otherwise stop to ask for another. */
async function checkPortsFree(): Promise<void> {
  for (const [name, port] of Object.entries(PORTS)) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer()
        .once('error', () => resolve(false))
        .once('listening', () => probe.close(() => resolve(true)))
        .listen(port, '127.0.0.1');
    });
    if (!free) fail(`Port ${port} (${name}) is in use. Is another e2e stack still running?`);
  }
}

function checkBuild(): void {
  const project = join(REPO_DIR, 'web/dist/shell/project.html');
  const bundle = join(REPO_DIR, 'api/dist/bundle.js');
  if (!existsSync(project) || !existsSync(bundle)) {
    fail('No build found. Run `npm run build` at the repository root first.');
  }
  // The same check the deploy workflow makes: the API embeds the project page from the web build,
  // so a bundle built against an older web/dist would serve script names that no longer exist.
  const script = readFileSync(project, 'utf8').match(/\/assets\/index-[A-Za-z0-9_-]*\.js/)?.[0];
  if (!script || !readFileSync(bundle, 'utf8').includes(script)) {
    fail('api/dist/bundle.js was built against a different web/dist. Run `npm run build` at the repository root.');
  }
}

/** A copy of the API as the deploy workflow stages it (bundle, host.json, package.json), plus local settings. */
function stageApi(): string {
  const dir = join(STACK_DIR, 'api');
  mkdirSync(join(dir, 'dist'), { recursive: true });
  copyFileSync(join(REPO_DIR, 'api/dist/bundle.js'), join(dir, 'dist/bundle.js'));
  copyFileSync(join(REPO_DIR, 'api/host.json'), join(dir, 'host.json'));
  copyFileSync(join(REPO_DIR, 'api/package.json'), join(dir, 'package.json'));
  writeFileSync(
    join(dir, 'local.settings.json'),
    JSON.stringify(
      {
        IsEncrypted: false,
        Values: {
          FUNCTIONS_WORKER_RUNTIME: 'node',
          TABLES_CONNECTION_STRING,
          ATLAS_API_BASE: `${RIPE_STUB_URL}/api/v2`,
          // As on dev: the route the tests use to delete the projects they post (test-cleanup.spec.ts).
          E2E_PROJECT_CLEANUP: '1',
        },
      },
      null,
      2,
    ),
  );
  return dir;
}

async function main(): Promise<void> {
  checkBuild();
  await checkPortsFree();
  rmSync(STACK_DIR, { recursive: true, force: true });
  mkdirSync(STACK_DIR, { recursive: true });
  const apiDir = stageApi();
  const bin = (name: string) => join(REPO_DIR, 'node_modules/.bin', name);

  const ripe = await startRipeStub(PORTS.ripe);
  process.on('exit', () => void ripe.close());

  start('azurite', bin('azurite'), [
    '--inMemoryPersistence',
    '--skipApiVersionCheck',
    '--disableTelemetry',
    '--blobPort', String(PORTS.blob),
    '--queuePort', String(PORTS.queue),
    '--tablePort', String(PORTS.table),
  ], { cwd: STACK_DIR });
  await waitFor('Azurite', `http://127.0.0.1:${PORTS.table}/`, 30_000);

  start('func', process.env.FUNC || 'func', ['start', '--port', String(PORTS.func)], {
    cwd: apiDir,
    env: { FUNCTIONS_CORE_TOOLS_TELEMETRY_OPTOUT: '1' },
  });
  await waitFor('Functions host', `${FUNC_URL}/api/stats`, 90_000);

  // From the repository root: started anywhere else, the emulator answered /sitemap.xml, a rewrite to
  // /api/sitemap, with its 404 page.
  start('swa', bin('swa'), [
    'start', 'web/dist',
    '--api-devserver-url', FUNC_URL,
    '--port', String(PORTS.swa),
  ], { cwd: REPO_DIR });

  console.log(`[e2e stack] Functions host, Azurite and the RIPE Atlas stub are up; logs in ${STACK_DIR}`);
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
