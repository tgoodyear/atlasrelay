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
