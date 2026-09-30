// Removes the test accounts' secrets from everything a run writes before it leaves the container:
// the console output, the Playwright report, and every file under the results directory, including
// the files inside trace archives. The secrets are the passwords, the TOTP seeds and the site's
// session cookies (a trace records every request's Cookie header).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

export const MASK = '[redacted]';

/**
 * Every form a secret takes in the files a run writes: as is, escaped inside a JSON string, and
 * URL-encoded. Longest first, so a secret that contains another is replaced whole.
 * @param {Iterable<string | undefined | null>} secrets
 * @returns {string[]}
 */
export function variants(secrets) {
  const out = new Set();
  for (const s of secrets) {
    if (!s) continue;
    out.add(s);
    out.add(JSON.stringify(s).slice(1, -1));
    out.add(encodeURIComponent(s));
  }
  return [...out].filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
}

/**
 * @param {string} text
 * @param {string[]} needles from variants()
 */
export function redactText(text, needles) {
  let out = text;
  for (const n of needles) out = out.split(n).join(MASK);
  return out;
}

/**
 * @param {Buffer} buf
 * @param {string[]} needles from variants()
 * @returns {{ buf: Buffer, changed: boolean }}
 */
export function redactBuffer(buf, needles) {
  let out = buf;
  let changed = false;
  const mask = Buffer.from(MASK);
  for (const n of needles) {
    const needle = Buffer.from(n);
    let at = out.indexOf(needle);
    if (at < 0) continue;
    changed = true;
    const parts = [];
    let from = 0;
    while (at >= 0) {
      parts.push(out.subarray(from, at), mask);
      from = at + needle.length;
      at = out.indexOf(needle, from);
    }
    parts.push(out.subarray(from));
    out = Buffer.concat(parts);
  }
  return { buf: out, changed };
}

/** @param {string} dir @returns {string[]} */
function files(dir) {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else out.push(p);
  }
  return out;
}

/**
 * Rewrites a zip archive with every entry redacted. Uses the zip and unzip commands.
 * @param {string} path
 * @param {string[]} needles
 * @returns {boolean} whether anything was replaced
 */
function redactZip(path, needles) {
  const work = mkdtempSync(join(tmpdir(), 'redact-'));
  try {
    const tree = join(work, 'tree');
    execFileSync('unzip', ['-qq', path, '-d', tree], { stdio: ['ignore', 'ignore', 'pipe'] });
    let changed = false;
    for (const f of files(tree)) {
      const r = redactBuffer(readFileSync(f), needles);
      if (r.changed) {
        writeFileSync(f, r.buf);
        changed = true;
      }
    }
    if (changed) {
      const rebuilt = join(work, 'out.zip');
      execFileSync('zip', ['-q', '-r', '-X', rebuilt, '.'], { cwd: tree, stdio: ['ignore', 'ignore', 'pipe'] });
      renameSync(rebuilt, path);
    }
    return changed;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Redacts every file under dir in place. A zip that cannot be rewritten is deleted rather than
 * kept as it is.
 * @param {string} dir
 * @param {string[]} needles from variants()
 * @returns {{ redacted: string[], withheld: string[] }} paths relative to dir
 */
export function redactTree(dir, needles) {
  /** @type {string[]} */
  const redacted = [];
  /** @type {string[]} */
  const withheld = [];
  if (needles.length === 0) return { redacted, withheld };
  for (const f of files(dir)) {
    const rel = relative(dir, f);
    if (f.endsWith('.zip')) {
      try {
        if (redactZip(f, needles)) redacted.push(rel);
      } catch {
        rmSync(f, { force: true });
        withheld.push(rel);
      }
      continue;
    }
    const r = redactBuffer(readFileSync(f), needles);
    if (r.changed) {
      writeFileSync(f, r.buf);
      redacted.push(rel);
    }
  }
  return { redacted, withheld };
}

/**
 * Passes text through line by line with the secrets replaced. Whole lines only, so a secret split
 * across two chunks of a stream is still caught.
 * @param {(line: string) => void} write
 * @param {() => string[]} needles read on every line, so secrets learned later still apply
 */
export function lineRedactor(write, needles) {
  let pending = '';
  return {
    /** @param {string} chunk */
    push(chunk) {
      pending += chunk;
      let nl = pending.indexOf('\n');
      while (nl >= 0) {
        write(redactText(pending.slice(0, nl + 1), needles()));
        pending = pending.slice(nl + 1);
        nl = pending.indexOf('\n');
      }
    },
    end() {
      if (pending) write(redactText(pending, needles()));
      pending = '';
    },
  };
}
