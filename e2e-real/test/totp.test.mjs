import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base32Decode, hotp, totp } from '../lib/totp.mjs';

// RFC 6238 appendix B (SHA-1): the key is the ASCII string "12345678901234567890".
const RFC_SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('base32 decodes the RFC seed, with spaces and lower case', () => {
  assert.equal(base32Decode(RFC_SEED).toString(), '12345678901234567890');
  assert.equal(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq').toString(), '12345678901234567890');
  assert.throws(() => base32Decode('not base32!'));
});

test('matches the RFC 6238 test vectors', () => {
  const key = base32Decode(RFC_SEED);
  assert.equal(hotp(key, Math.floor(59 / 30), 8), '94287082');
  assert.equal(hotp(key, Math.floor(1111111109 / 30), 8), '07081804');
  assert.equal(hotp(key, Math.floor(2000000000 / 30), 8), '69279037');
  assert.equal(totp(RFC_SEED, 59_000), '287082');
});
