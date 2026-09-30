import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpRequest } from '@azure/functions';
import { getPrincipal } from '../src/lib/auth';

function request(principal?: object): HttpRequest {
  const headers: Record<string, string> = {};
  if (principal) headers['x-ms-client-principal'] = Buffer.from(JSON.stringify(principal)).toString('base64');
  return new HttpRequest({ method: 'GET', url: 'https://example.org/api/me', headers });
}

const signedIn = { identityProvider: 'github', userId: 'abc123', userDetails: 'octocat', userRoles: ['anonymous', 'authenticated'] };

test('the principal Static Web Apps sends is decoded', () => {
  assert.deepEqual(getPrincipal(request(signedIn), {}), { ...signedIn });
  assert.equal(getPrincipal(request(), {}), null);
  assert.equal(getPrincipal(request({ ...signedIn, userRoles: ['anonymous'] }), {}), null);
});

test('an app that is not linked to the site treats every request as anonymous', () => {
  assert.equal(getPrincipal(request(signedIn), { IGNORE_CLIENT_PRINCIPAL: '1' }), null);
  assert.deepEqual(getPrincipal(request(signedIn), { IGNORE_CLIENT_PRINCIPAL: '' }), { ...signedIn });
});
