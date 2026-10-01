// The run's summary.json, built from the Playwright JSON report. The workflow reads its status to
// pass or fail, and prints its test list on the run page.

/** @param {string} s */
export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

/** @param {string | undefined} s */
function brief(s) {
  if (!s) return undefined;
  const clean = stripAnsi(s).trim();
  return clean.length > 2000 ? `${clean.slice(0, 2000)}...` : clean;
}

/**
 * @typedef {{ status?: string, duration?: number, error?: { message?: string } }} PwResult
 * @typedef {{ status?: string, results?: PwResult[] }} PwTest
 * @typedef {{ title?: string, file?: string, tests?: PwTest[] }} PwSpec
 * @typedef {{ title?: string, specs?: PwSpec[], suites?: PwSuite[] }} PwSuite
 * @typedef {{ suites?: PwSuite[], errors?: { message?: string }[], stats?: { expected?: number, unexpected?: number, flaky?: number, skipped?: number } }} PwReport
 */

/**
 * @param {PwReport | null} report the parsed report.json, or null when Playwright wrote none
 * @param {{ exitCode: number | null, [key: string]: unknown }} run facts about the run, copied in
 */
export function summarize(report, run) {
  /** @type {{ title: string, file?: string, outcome: string, durationMs: number, error?: string }[]} */
  const tests = [];
  /** @param {PwSuite} suite @param {string[]} path */
  const walk = (suite, path) => {
    const here = suite.title ? [...path, suite.title] : path;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const results = t.results ?? [];
        tests.push({
          title: [...here, spec.title ?? ''].filter(Boolean).join(' > '),
          file: spec.file,
          outcome: t.status ?? 'unknown',
          durationMs: results.reduce((sum, r) => sum + (r.duration ?? 0), 0),
          error: brief(results.at(-1)?.error?.message),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, here);
  };
  for (const s of report?.suites ?? []) walk(s, []);

  const stats = {
    expected: report?.stats?.expected ?? 0,
    unexpected: report?.stats?.unexpected ?? 0,
    flaky: report?.stats?.flaky ?? 0,
    skipped: report?.stats?.skipped ?? 0,
  };
  const errors = (report?.errors ?? []).map((e) => brief(e.message) ?? '').filter(Boolean).slice(0, 5);
  // Passed means Playwright exited cleanly, nothing failed, and at least one test ran and passed:
  // a run where sign-in failed in global setup has no passing test.
  const passed = run.exitCode === 0 && stats.unexpected === 0 && errors.length === 0 && stats.expected > 0;
  return {
    ...run,
    status: report ? (passed ? 'passed' : 'failed') : 'error',
    stats,
    tests,
    errors,
  };
}
