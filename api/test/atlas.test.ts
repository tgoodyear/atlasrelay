import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertKeyFormat, describeAtlasError } from '../src/lib/atlas';
import { HttpError } from '../src/lib/http';

test('assertKeyFormat only accepts UUIDs', () => {
  assert.equal(assertKeyFormat(' 12345678-1234-1234-1234-123456789abc '), '12345678-1234-1234-1234-123456789abc');
  assert.throws(() => assertKeyFormat('not-a-key'), HttpError);
  assert.throws(() => assertKeyFormat(undefined), HttpError);
});

test('describeAtlasError surfaces RIPE detail and field errors', () => {
  const msg = describeAtlasError(400, {
    error: { status: 400, detail: 'The following fields are invalid: recipient', errors: [{ source: { pointer: '/recipient' }, detail: 'Unknown user.' }] },
  });
  assert.equal(msg, 'The following fields are invalid: recipient recipient: Unknown user.');
});

test('describeAtlasError has sane fallbacks', () => {
  assert.match(describeAtlasError(403, null), /rejected the API key/);
  assert.match(describeAtlasError(429, {}), /rate-limiting/);
  assert.match(describeAtlasError(500, ''), /HTTP 500/);
});
