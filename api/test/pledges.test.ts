import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totals } from '../src/lib/store';

test('totals splits confirmed from pending and ignores cancelled', () => {
  const base = { id: '', projectId: '', donorId: '', donorName: '', method: 'manual' as const, transactionUrl: '', message: '', createdAt: '', updatedAt: '' };
  const t = totals([
    { ...base, amount: 100, status: 'confirmed' },
    { ...base, amount: 50, status: 'pledged' },
    { ...base, amount: 25, status: 'sent' },
    { ...base, amount: 999, status: 'cancelled' },
  ]);
  assert.deepEqual(t, { confirmed: 100, pending: 75 });
});
