// Entry point of the test image (the Container Apps job caj-atlasrelay-<env>-e2e):
//
// 1. Read the two test accounts from Key Vault with the job's managed identity. Outside the job,
//    set E2E_RESEARCHER_USERNAME, E2E_RESEARCHER_PASSWORD, E2E_DONOR_USERNAME and
//    E2E_DONOR_PASSWORD instead (and E2E_*_TOTP when an account has a TOTP seed).
// 2. Run the Playwright suite. Its output is printed with every secret replaced.
// 3. Redact the results directory: the passwords, TOTP seeds and the site's session cookies, which
//    traces record in request headers.
// 4. Write summary.json and upload the directory to RESULTS_CONTAINER_URL/runs/<run id>/, when set.
// 5. Exit 0 only if the suite passed.
//
// No secret is ever printed, written to the results or passed on the command line.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSecret, managedIdentityToken, putBlob } from './lib/azure.mjs';
import { lineRedactor, redactText, redactTree, variants } from './lib/redact.mjs';
import { summarize } from './lib/summary.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const startedAt = new Date().toISOString();
const runId = safeId(process.env.E2E_RUN_ID || process.env.CONTAINER_APP_JOB_EXECUTION_NAME || `local-${startedAt.replace(/[:.]/g, '-')}`);
const outDir = process.env.E2E_OUTPUT_DIR || join(tmpdir(), 'atlasrelay-e2e', runId);
const stateDir = mkdtempSync(join(tmpdir(), 'atlasrelay-e2e-state-'));

/** @type {string[]} every secret learned so far, in all its forms */
let needles = [];
/** @type {string[]} the account secrets, before the session cookies are added */
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

const ROLES = /** @type {const} */ (['researcher', 'donor']);
const FIELDS = /** @type {const} */ (['username', 'password', 'totp']);

/** @returns {Promise<Record<string, string>>} E2E_<ROLE>_<FIELD> for every account field */
async function accounts() {
  /** @type {Record<string, string>} */
  const env = {};
  const vaultUri = process.env.KEY_VAULT_URI;
  let token = '';
  for (const role of ROLES) {
    for (const field of FIELDS) {
      const key = `E2E_${role.toUpperCase()}_${field.toUpperCase()}`;
      if (process.env[key]) {
        env[key] = process.env[key] ?? '';
        continue;
      }
      if (!vaultUri) {
        if (field === 'totp') continue;
        throw new Error(`Set ${key}, or KEY_VAULT_URI to read the accounts from Key Vault`);
      }
      const name = process.env[`${key}_SECRET`];
      if (!name) {
        if (field === 'totp') continue;
        throw new Error(`${key}_SECRET names no Key Vault secret`);
      }
      token ||= await managedIdentityToken('https://vault.azure.net', process.env.AZURE_CLIENT_ID);
      env[key] = await getSecret(vaultUri, name, token, { optional: field === 'totp' });
      if (!env[key] && field !== 'totp') throw new Error(`Key Vault secret ${name} is empty; run scripts/set-test-users.sh`);
    }
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

/** @param {Record<string, string>} env */
function runPlaywright(env) {
  const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, 'test', '-c', join(here, 'playwright.config.ts')], {
      cwd: here,
      env: { ...process.env, ...env, E2E_STATE_DIR: stateDir, E2E_OUTPUT_DIR: outDir, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
mkdirSync(outDir, { recursive: true });
try {
  log(`run ${runId} against ${process.env.BASE_URL ?? '(BASE_URL unset)'}`);
  const env = await accounts();
  accountSecrets = Object.entries(env).filter(([k]) => !k.endsWith('_USERNAME')).map(([, v]) => v);
  needles = variants(accountSecrets);
  exitCode = await runPlaywright(env);
} catch (err) {
  setupError = /** @type {Error} */ (err).message;
  log(`error: ${setupError}`);
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
