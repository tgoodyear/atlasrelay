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

test('the pledge handler records the uncertainty before it can be caused', () => {
  // The record of "we do not know whether the credits moved" has to be written before the POST, not
  // after. Written after, it can only exist if the handler survives the very failure it describes, and a
  // process that dies between the POST and that write leaves the row saying `pledged` -- whose meaning is
  // that nothing was sent. Ordering is the whole guarantee, exactly as it is for transferIssued, so assert
  // it in the source the same way.
  const src = readFileSync(join(repoRoot, 'api', 'src', 'functions', 'pledges.ts'), 'utf8');
  const marker = src.indexOf('pledge.transferUncertain = true;');
  const post = src.indexOf('await transferCredits(');
  assert.ok(marker > 0, 'pledges.ts no longer marks a transfer uncertain before issuing it');
  assert.ok(post > 0, 'pledges.ts no longer calls transferCredits');
  assert.ok(marker < post, 'the uncertainty is recorded before the transfer that may cause it');

  // And it must be narrowed on success, or every completed transfer stores confirmed-and-uncertain and
  // the "Transferred via API" badge disappears from every pledge on the site.
  const cleared = src.indexOf('pledge.transferUncertain = false;');
  assert.ok(cleared > post, 'a confirmed transfer must clear the pessimistic marker');
});

test('the pledge handler reads the owner after its marker is stored and before the transfer (#20)', () => {
  // Profile deletion removes the owner and then looks for pledges already marked in flight on their
  // projects. That only catches every race if the pledge side does the mirror image: write the marker,
  // then read the owner. Read the owner first and a deletion landing between that read and the marker
  // sees no marker, while this request goes on to send credits to the address it was told is gone.
  const src = readFileSync(join(repoRoot, 'api', 'src', 'functions', 'pledges.ts'), 'utf8');
  const marker = src.indexOf('pledge.etag = (await savePledge(pledge, pledge.etag)).etag;');
  const owner = src.indexOf('ownerNow = await getUser(');
  const post = src.indexOf('await transferCredits(');
  assert.ok(marker > 0, 'pledges.ts no longer writes the transfer marker');
  assert.ok(owner > 0, 'pledges.ts no longer re-reads the owner before transferring');
  assert.ok(marker < owner, 'the owner is read after the marker is stored');
  assert.ok(owner < post, 'the owner is read before the transfer');
});

test('an owner key is only used after every rule that could refuse the confirmation has passed', () => {
  // The RIPE read is the one step in the update handler that sends something outside this site, and it
  // sends the owner's key. Every check that can refuse the request without it -- who may act, which
  // transitions are allowed, the in-flight window, the expiry rule -- has to come first, so a request
  // that was always going to be refused never carries the key to RIPE at all.
  const src = readFileSync(join(repoRoot, 'api', 'src', 'functions', 'pledges.ts'), 'utf8');
  const update = src.slice(src.indexOf("app.http('pledges-update'"));
  const read = update.indexOf('await checkReceipt(');
  assert.ok(read > 0, 'the update handler no longer checks receipts');
  for (const guard of ["throw new HttpError(403, 'Not allowed')", 'if (!ok) throw', 'if (pledgeInFlight(pledge))', "pledge.method !== 'manual'", 'assertKeyFormat(body.apiKey)']) {
    const at = update.indexOf(guard);
    assert.ok(at > 0, `the update handler no longer contains ${guard}`);
    assert.ok(at < read, `${guard} runs before the RIPE read`);
  }
});

test('a confirmation holds the project lock only around the totals read, the ceiling check and the write', () => {
  // Two confirmations on one project could otherwise both read a total under the ceiling and both
  // write. The slow reads (the owner's whole pledge history and RIPE) stay outside the lock, so a
  // long history cannot outlast the lock's grace and let a second request take it mid-confirmation.
  const src = readFileSync(join(repoRoot, 'api', 'src', 'functions', 'pledges.ts'), 'utf8');
  const update = src.slice(src.indexOf("app.http('pledges-update'"));
  const ledger = update.indexOf('await ownerReceiptLedger(');
  const ripe = update.indexOf('await checkReceipt(');
  const lock = update.indexOf('await acquireConfirmLock(');
  const totalsRead = update.indexOf('totals(await listPledges(projectId))', lock);
  const save = update.indexOf('await savePledge(', lock);
  const release = update.indexOf('releaseConfirmLock(', save);
  assert.ok(ledger > 0 && ripe > 0 && lock > 0, 'the update handler no longer reads the ledger, checks RIPE and locks');
  assert.ok(ledger < lock, 'the owner history is read before the lock is taken');
  assert.ok(ripe < lock, 'RIPE is read before the lock is taken');
  assert.ok(totalsRead > lock, 'the confirmed total is read again under the lock');
  assert.ok(save > totalsRead, 'the pledge is written after that read, under the lock');
  assert.ok(release > save, 'the lock is released after the pledge is written');
  // Nothing slow between taking the lock and writing.
  const locked = update.slice(lock, save);
  for (const slow of ['ownerReceiptLedger(', 'checkReceipt(', 'reserveReceipt(', 'listProjectsByOwner(']) {
    assert.equal(locked.includes(slow), false, `${slow} runs under the lock`);
  }
});
