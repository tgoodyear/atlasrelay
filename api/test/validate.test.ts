import { test } from 'node:test';
import assert from 'node:assert/strict';
import { email, httpsUrl, int, str, tags } from '../src/lib/validate';
import { HttpError } from '../src/lib/http';

test('str trims and enforces length', () => {
  assert.equal(str({ a: '  hi ' }, 'a', { max: 5 }), 'hi');
  assert.throws(() => str({ a: 'toolong' }, 'a', { max: 3 }), HttpError);
  assert.throws(() => str({}, 'a', { max: 3, required: true }), HttpError);
  assert.equal(str({}, 'a', { max: 3 }), undefined);
});

test('int accepts whole numbers in range', () => {
  assert.equal(int({ n: 5 }, 'n', { min: 1, max: 10 }), 5);
  assert.equal(int({ n: '7' }, 'n', { min: 1, max: 10 }), 7);
  assert.throws(() => int({ n: 1.5 }, 'n', { min: 1, max: 10 }), HttpError);
  assert.throws(() => int({ n: 0 }, 'n', { min: 1, max: 10 }), HttpError);
});

test('email lowercases and validates', () => {
  assert.equal(email({ e: 'A@B.co' }, 'e'), 'a@b.co');
  assert.throws(() => email({ e: 'nope' }, 'e'), HttpError);
});

test('httpsUrl rejects javascript: and accepts https', () => {
  assert.equal(httpsUrl({ u: 'https://example.org/x' }, 'u'), 'https://example.org/x');
  assert.throws(() => httpsUrl({ u: 'javascript:alert(1)' }, 'u'), HttpError);
});

test('tags dedupes and rejects unknown', () => {
  assert.deepEqual(tags({ tags: ['dns', 'dns', 'ping'] }), ['dns', 'ping']);
  assert.throws(() => tags({ tags: ['bogus'] }), HttpError);
});

test('a link field called httpsUrl actually requires https', () => {
  // The function is named httpsUrl, its error says "must start with https://", and the project fields using
  // it are documented as https-only. It accepted http as well, so all three disagreed and a project could
  // carry an http homepage, repo, paper or results link against a contract that promised otherwise.
  assert.equal(httpsUrl({ u: 'https://example.org/x' }, 'u'), 'https://example.org/x');
  assert.throws(() => httpsUrl({ u: 'http://example.org/x' }, 'u'), /must start with https/);
  // Anything that is not a URL at all is still its own error, and absent is still absent.
  assert.throws(() => httpsUrl({ u: 'not a url' }, 'u'), /must be a valid URL/);
  assert.equal(httpsUrl({}, 'u'), undefined);
  assert.equal(httpsUrl({ u: '' }, 'u'), '');
});
