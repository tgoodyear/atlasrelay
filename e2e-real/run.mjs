// Entry point of the test image (the Container Apps job caj-atlasrelay-<env>-e2e):
//
// 1. Read the two test accounts, and the two RIPE Atlas keys with their accounts' emails, from Key
//    Vault with the job's managed identity. Outside the job, set E2E_RESEARCHER_USERNAME,
//    E2E_RESEARCHER_PASSWORD, E2E_DONOR_USERNAME and E2E_DONOR_PASSWORD instead (and E2E_*_TOTP
//    when an account has a TOTP seed), plus E2E_RIPE_DONOR_KEY, E2E_RIPE_DONOR_ACCOUNT,
//    E2E_RIPE_RECIPIENT_KEY and E2E_RIPE_RECIPIENT_ACCOUNT for the real-transfer tests.
// 2. Take the lock every run of the job shares (lib/lock.mjs), when RESULTS_CONTAINER_URL is set,
//    so two runs never sign the same accounts in or move credits at the same time. A run that
//    loses the lock stops the suite the way Ctrl+C does: the running test is interrupted, its
//    afterEach hooks still run (the credit return among them), and the run fails.
// 3. Run the Playwright suite. Its output is printed with every secret replaced.
// 4. Redact the results directory: the passwords, TOTP seeds, RIPE keys and account emails, and
//    the site's session cookies, which traces record in request headers.
// 5. Write summary.json and upload the directory to RESULTS_CONTAINER_URL/runs/<run id>/, when set.
// 6. Exit 0 only if the suite passed.
//
// No secret is ever printed, written to the results or passed on the command line.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSecret, managedIdentityToken, putBlob } from './lib/azure.mjs';
import { acquireLock } from './lib/lock.mjs';
import { lineRedactor, redactText, redactTree, secretValues, variants } from './lib/redact.mjs';
import { summarize } from './lib/summary.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const startedAt = new Date().toISOString();
const runId = safeId(process.env.E2E_RUN_ID || process.env.CONTAINER_APP_JOB_EXECUTION_NAME || `local-${startedAt.replace(/[:.]/g, '-')}`);
const outDir = process.env.E2E_OUTPUT_DIR || join(tmpdir(), 'atlasrelay-e2e', runId);
const stateDir = mkdtempSync(join(tmpdir(), 'atlasrelay-e2e-state-'));

/** @type {string[]} every secret learned so far, in all its forms */
let needles = [];
/** @type {string[]} the secrets from secrets(), before the session cookies are added */
let accountSecrets = [];
// The session cookies appear once global setup has saved the signed-in browser states; the output
// is redacted for them from then on.
let stateKey = '';
function currentNeedles() {
  let key = '';
  try {
    key = readdirSync(stateDir).map((n) => `${n}:${statSync(join(stateDir, n)).size}`).join(',');
  } catch {
    // The directory is gone: the run is over.
  }
  if (key && key !== stateKey) {
    stateKey = key;
    needles = variants([...accountSecrets, ...cookieValues()]);
  }
  return needles;
}
const out = lineRedactor((s) => process.stdout.write(s), currentNeedles);
/** @type {string[]} */
const consoleLog = [];
/** @param {string} line */
function log(line) {
  const text = redactText(`${line}\n`, needles);
  process.stdout.write(text);
  consoleLog.push(text);
}

/** @param {string} s */
function safeId(s) {
  return s.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100);
}

/**
 * Every value the suite is given. The Microsoft accounts are required, their TOTP seeds optional.
 * The RIPE values are all or nothing: a job whose definition names none of them runs without the
 * real-transfer tests (they skip and say so), and one that names them needs all four.
 * @type {{ name: string, optional?: boolean, group: 'accounts' | 'ripe', hint: string }[]}
 */
const FIELDS = [
  ...['RESEARCHER', 'DONOR'].flatMap((role) =>
    ['USERNAME', 'PASSWORD', 'TOTP'].map((field) => ({
      name: `E2E_${role}_${field}`,
      optional: field === 'TOTP',
      group: /** @type {const} */ ('accounts'),
      hint: 'scripts/set-test-users.sh',
    })),
  ),
  ...['DONOR_KEY', 'DONOR_ACCOUNT', 'RECIPIENT_KEY', 'RECIPIENT_ACCOUNT'].map((field) => ({
    name: `E2E_RIPE_${field}`,
    group: /** @type {const} */ ('ripe'),
    hint: 'scripts/set-ripe-keys.sh',
  })),
];

/** @returns {Promise<Record<string, string>>} the variables to hand the suite */
async function secrets() {
  /** @type {Record<string, string>} */
  const env = {};
  const vaultUri = process.env.KEY_VAULT_URI;
  const ripeNamed = FIELDS.some((f) => f.group === 'ripe' && (process.env[f.name] || process.env[`${f.name}_SECRET`]));
  let token = '';
  for (const f of FIELDS) {
    if (f.group === 'ripe' && !ripeNamed) continue;
    if (process.env[f.name]) {
      env[f.name] = process.env[f.name] ?? '';
      continue;
    }
    const secretName = process.env[`${f.name}_SECRET`];
    if (!vaultUri || !secretName) {
      if (f.optional) continue;
      throw new Error(vaultUri ? `${f.name}_SECRET names no Key Vault secret` : `Set ${f.name}, or KEY_VAULT_URI to read it from Key Vault`);
    }
    token ||= await managedIdentityToken('https://vault.azure.net', process.env.AZURE_CLIENT_ID);
    env[f.name] = await getSecret(vaultUri, secretName, token, { optional: true });
    if (!env[f.name] && !f.optional) throw new Error(`Key Vault secret ${secretName} is missing or empty; run ${f.hint}`);
  }
  return env;
}

/** Session cookies the sign-in left in the saved browser states. */
function cookieValues() {
  /** @type {string[]} */
  const values = [];
  if (!existsSync(stateDir)) return values;
  for (const name of readdirSync(stateDir)) {
    try {
      const state = JSON.parse(readFileSync(join(stateDir, name), 'utf8'));
      for (const c of state.cookies ?? []) if (c.value) values.push(c.value);
      for (const o of state.origins ?? []) for (const item of o.localStorage ?? []) if (item.value && item.value.length >= 16) values.push(item.value);
    } catch {
      // Not a state file.
    }
  }
  return values;
}

/** @type {import('node:child_process').ChildProcess | null} the Playwright runner, while it runs */
let playwright = null;
let lockLost = false;

/** The lock is gone: stop the suite as Ctrl+C would, so the afterEach hooks still run. */
function stopForLostLock() {
  lockLost = true;
  if (playwright && playwright.exitCode === null) {
    log('stopping the tests: this run no longer holds the lock');
    playwright.kill('SIGINT');
  }
}

/** @param {Record<string, string>} env */
function runPlaywright(env) {
  const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, 'test', '-c', join(here, 'playwright.config.ts')], {
      cwd: here,
      env: { ...process.env, ...env, E2E_STATE_DIR: stateDir, E2E_OUTPUT_DIR: outDir, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    playwright = child;
    const err = lineRedactor((s) => process.stderr.write(s), currentNeedles);
    // console.txt is redacted as a whole at the end, so a secret split across chunks is caught.
    child.stdout.setEncoding('utf8').on('data', (c) => {
      out.push(c);
      consoleLog.push(c);
    });
    child.stderr.setEncoding('utf8').on('data', (c) => {
      err.push(c);
      consoleLog.push(c);
    });
    child.on('close', (code) => {
      out.end();
      err.end();
      resolve(code ?? 1);
    });
    child.on('error', (e) => {
      log(`could not start Playwright: ${e.message}`);
      resolve(1);
    });
  });
}

/** @param {string} dir @returns {string[]} */
function files(dir) {
  /** @type {string[]} */
  const found = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) found.push(...files(p));
    else found.push(p);
  }
  return found;
}

const TYPES = { '.json': 'application/json', '.md': 'text/markdown', '.txt': 'text/plain', '.png': 'image/png', '.zip': 'application/zip', '.webm': 'video/webm' };

async function upload() {
  const container = process.env.RESULTS_CONTAINER_URL;
  if (!container) {
    log(`results are in ${outDir} (RESULTS_CONTAINER_URL is unset, nothing uploaded)`);
    return;
  }
  const token = await managedIdentityToken('https://storage.azure.com/', process.env.AZURE_CLIENT_ID);
  // summary.json last: the workflow treats its presence as "the upload finished".
  const all = files(outDir).sort((a, b) => Number(a.endsWith('summary.json')) - Number(b.endsWith('summary.json')));
  for (const f of all) {
    const rel = relative(outDir, f).split('\\').join('/');
    await putBlob(container, `runs/${runId}/${rel}`, readFileSync(f), TYPES[/** @type {keyof typeof TYPES} */ (extname(f))] ?? 'application/octet-stream', token);
  }
  log(`uploaded ${all.length} files to ${container}/runs/${runId}/`);
}

let exitCode = 1;
let setupError = '';
/** @type {import('./lib/lock.mjs').Lock | null} */
let lock = null;
mkdirSync(outDir, { recursive: true });
try {
  log(`run ${runId} against ${process.env.BASE_URL ?? '(BASE_URL unset)'}`);
  const env = await secrets();
  accountSecrets = secretValues(env);
  if (!env.E2E_RIPE_DONOR_KEY) log('the job names no RIPE Atlas keys, so the real-transfer tests will skip');
  needles = variants(accountSecrets);
  const container = process.env.RESULTS_CONTAINER_URL;
  if (container) {
    const token = await managedIdentityToken('https://storage.azure.com/', process.env.AZURE_CLIENT_ID);
    lock = await acquireLock(container, token, { log, onLost: stopForLostLock });
    log('holding the lock: no other run can start the tests until this one ends');
    if (lockLost) throw new Error('lost the lock before the tests started');
  } else {
    log('RESULTS_CONTAINER_URL is unset, so this run takes no lock; make sure no other run is going');
  }
  exitCode = await runPlaywright(env);
} catch (err) {
  setupError = /** @type {Error} */ (err).message;
  log(`error: ${setupError}`);
}
if (lock) {
  await lock.release();
  if (lockLost) {
    setupError ||= 'this run lost the lock while the tests ran, so another run may have overlapped it; the suite was stopped';
    exitCode = 1;
  } else {
    log('released the lock');
  }
}

// Everything below runs whatever happened above, so a failed run still reports.
needles = variants([...accountSecrets, ...cookieValues()]);
rmSync(stateDir, { recursive: true, force: true });
writeFileSync(join(outDir, 'console.txt'), redactText(consoleLog.join(''), needles));
const redaction = redactTree(outDir, needles);
let report = null;
try {
  report = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8'));
} catch {
  // No report: Playwright did not start or global setup failed before it wrote one.
}
const summary = summarize(report, {
  runId,
  baseUrl: process.env.BASE_URL,
  image: process.env.E2E_IMAGE,
  gitSha: process.env.E2E_GIT_SHA,
  startedAt,
  finishedAt: new Date().toISOString(),
  exitCode: setupError ? null : exitCode,
  setupError: setupError || undefined,
  redactedFiles: redaction.redacted,
  withheldFiles: redaction.withheld,
});
writeFileSync(join(outDir, 'summary.json'), redactText(JSON.stringify(summary, null, 2), needles));
log(`E2E_RESULT ${JSON.stringify({ runId, status: summary.status, stats: summary.stats })}`);
try {
  await upload();
} catch (err) {
  log(`upload failed: ${/** @type {Error} */ (err).message}`);
  exitCode = 1;
}
process.exit(summary.status === 'passed' && exitCode === 0 ? 0 : 1);
