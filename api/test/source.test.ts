import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// The api workspace compiles to CommonJS, so import.meta is unavailable. process.cwd() is the
// workspace root when npm runs the test script, which is one level below the repository root.
const repoRoot = join(process.cwd(), '..');
const SCANNED = ['api/src', 'web/src'];
const EXTENSIONS = ['.ts', '.tsx'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (EXTENSIONS.some((e) => full.endsWith(e))) out.push(full);
    }
  };
  walk(dir);
  return out;
}

const files = SCANNED.flatMap((d) => sourceFiles(join(repoRoot, d)));

test('the source scan actually finds files, so a silent zero cannot pass', () => {
  assert.ok(files.length > 15, `expected to scan real source files, found ${files.length}`);
});

test('no unicode escape sequences in source, because JSX text does not interpret them', () => {
  // A literal ’ inside a JSX text node is not an escape. JSX text is taken as written, so it
  // renders on screen as the six characters backslash-u-2-0-1-9 rather than an apostrophe. This
  // shipped: the transfer dialog read "your account’s log" to every donor who completed a
  // transfer. The same escape inside a JS string literal does resolve, which is exactly what makes
  // it easy to get wrong, so the rule is simply to write the character itself everywhere.
  const offenders: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      const m = line.match(/\\u[0-9a-fA-F]{4}/);
      if (m) offenders.push(`${relative(repoRoot, file)}:${i + 1} contains ${m[0]} — write the character instead`);
    });
  }
  assert.deepEqual(offenders, [], `\n${offenders.join('\n')}\n`);
});

test('no other backslash escapes in source outside of string literals we control', () => {
  // The same trap with \n and \t: literal in JSX text, an escape in a string. Neither belongs in
  // rendered copy. Regular expressions and template literals legitimately use them, so only plain
  // prose lines are checked: a line with no quote, slash or backtick on it is copy, not code.
  const offenders: string[] = [];
  for (const file of files.filter((f) => f.endsWith('.tsx'))) {
    const text = readFileSync(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (/['"`/]/.test(line)) return;
      const m = line.match(/\\[ntr]/);
      if (m) offenders.push(`${relative(repoRoot, file)}:${i + 1} contains ${m[0]} in rendered text`);
    });
  }
  assert.deepEqual(offenders, [], `\n${offenders.join('\n')}\n`);
});

test('the post limiter takes its window before the project row is written', () => {
  // Order is the enforcement. Taking the window after the write would make it a count read before
  // a write dressed up as a row: a burst of concurrent posts would each write a project and only
  // then discover they were too fast, which is the same defect the open-project cap has now been
  // caught by twice and the reason the pledge claim is taken first.
  const src = readFileSync(join(repoRoot, 'api', 'src', 'functions', 'projects.ts'), 'utf8');
  const window = src.indexOf('acquireProjectPostWindow(');
  const write = src.indexOf('await createProject(');
  assert.ok(window > 0, 'projects.ts no longer takes a posting window');
  assert.ok(write > 0, 'projects.ts no longer creates project rows');
  assert.ok(window < write, 'the posting window is taken before the project row is written');
});

test('the pledge handler decides a transfer was issued before it issues one', () => {
  // The flag gates a blanket "nothing was sent" onto every error the handler raises above it.
  // Setting it after the POST rather than before would extend that promise over the POST itself,
  // so a transfer whose outcome is genuinely unknown would tell the donor it never happened and
  // invite them to send the same credits again. Order is the whole guarantee, so assert it.
  const src = readFileSync(join(repoRoot, 'api', 'src', 'functions', 'pledges.ts'), 'utf8');
  const flag = src.indexOf('transferIssued = true');
  const post = src.indexOf('await transferCredits(');
  assert.ok(flag > 0, 'pledges.ts no longer marks when a transfer has been issued');
  assert.ok(post > 0, 'pledges.ts no longer calls transferCredits');
  assert.ok(flag < post, 'the transfer is issued before the handler stops promising nothing was sent');
});
