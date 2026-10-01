import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarize } from '../lib/summary.mjs';

const report = (status, unexpected) => ({
  suites: [
    {
      title: 'full-flow.spec.ts',
      specs: [],
      suites: [],
    },
    {
      title: 'full-flow.spec.ts',
      specs: [
        {
          title: 'the flow',
          file: 'full-flow.spec.ts',
          tests: [{ status, results: [{ duration: 1200, error: unexpected ? { message: '\u001b[31mExpected\u001b[39m visible' } : undefined }] }],
        },
        { title: 'placeholder', file: 'ripe-transfer.spec.ts', tests: [{ status: 'skipped', results: [] }] },
      ],
    },
  ],
  errors: [],
  stats: { expected: unexpected ? 0 : 1, unexpected: unexpected ? 1 : 0, flaky: 0, skipped: 1 },
});

test('a clean run passes', () => {
  const s = summarize(report('expected', false), { exitCode: 0, runId: 'r1' });
  assert.equal(s.status, 'passed');
  assert.equal(s.runId, 'r1');
  assert.deepEqual(s.stats, { expected: 1, unexpected: 0, flaky: 0, skipped: 1 });
  assert.deepEqual(s.tests.map((t) => [t.title, t.outcome]), [
    ['full-flow.spec.ts > the flow', 'expected'],
    ['full-flow.spec.ts > placeholder', 'skipped'],
  ]);
});

test('a failed test fails the run and its error loses the colour codes', () => {
  const s = summarize(report('unexpected', true), { exitCode: 1 });
  assert.equal(s.status, 'failed');
  assert.equal(s.tests[0].error, 'Expected visible');
});

test('global setup errors, a non-zero exit, or nothing run all fail', () => {
  assert.equal(summarize({ ...report('expected', false), errors: [{ message: 'Signing in the donor account failed' }] }, { exitCode: 1 }).status, 'failed');
  assert.equal(summarize(report('expected', false), { exitCode: 1 }).status, 'failed');
  assert.equal(summarize({ suites: [], errors: [], stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 1 } }, { exitCode: 0 }).status, 'failed');
  assert.equal(summarize(null, { exitCode: null }).status, 'error');
});
