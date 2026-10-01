import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpRequest } from '@azure/functions';
import { acceptedProviders, accountId, getPrincipal } from '../src/lib/auth';

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

const ALL = { SIGNIN_PROVIDERS: 'github,aad,google,orcid' };

test('Google and ORCID principals are accepted, with ids that cannot reach another provider\'s account', () => {
  const orcid = { identityProvider: 'orcid', userId: 'abc123', userDetails: 'Josiah Carberry', userRoles: ['anonymous', 'authenticated'] };
  assert.deepEqual(getPrincipal(request(orcid), ALL), { ...orcid, userId: 'orcid:abc123' });
  const google = { ...orcid, identityProvider: 'google', userDetails: 'someone@gmail.com' };
  assert.deepEqual(getPrincipal(request(google), ALL), { ...google, userId: 'google:abc123' });
  // The same id from GitHub, Google and ORCID is three different accounts.
  const ids = ['github', 'aad', 'google', 'orcid'].map((identityProvider) => getPrincipal(request({ ...signedIn, identityProvider }), ALL)?.userId);
  assert.deepEqual(ids, ['abc123', 'abc123', 'google:abc123', 'orcid:abc123']);
  assert.equal(accountId('orcid', 'x'), 'orcid:x');
  assert.equal(accountId('github', 'x'), 'x');
});

test('a principal from a provider the site does not offer is anonymous', () => {
  for (const identityProvider of ['facebook', 'twitter', 'apple', 'myProvider', '']) {
    assert.equal(getPrincipal(request({ ...signedIn, identityProvider }), ALL), null, identityProvider);
  }
  // Provider names are compared without case; the stored name is lower case.
  assert.equal(getPrincipal(request({ ...signedIn, identityProvider: 'ORCID' }), ALL)?.identityProvider, 'orcid');
});

test('a principal with no name gets a placeholder from the provider\'s id, and odd ids are refused', () => {
  const p = getPrincipal(request({ identityProvider: 'orcid', userId: 'f00ba4cafe', userDetails: '', userRoles: ['authenticated'] }), ALL);
  assert.equal(p?.userDetails, 'user-f00ba4');
  // A GitHub id of "orcid:x" must not land on the ORCID account x.
  for (const userId of ['a/b', 'a#b', 'a?b', 'a\\b', 'a\nb', 'orcid:abc123', 42]) {
    assert.equal(getPrincipal(request({ ...signedIn, userId }), ALL), null, String(userId));
  }
});

test('the API accepts Google and ORCID only where the environment has registrations for them', () => {
  const orcid = { identityProvider: 'orcid', userId: 'abc123', userDetails: 'Josiah Carberry', userRoles: ['authenticated'] };
  const google = { ...orcid, identityProvider: 'google' };
  // Built-in sign-in: Static Web Apps may still answer /.auth/login/google itself; no account follows.
  for (const env of [{}, { SIGNIN_PROVIDERS: '' }, { SIGNIN_PROVIDERS: 'github,aad' }]) {
    assert.equal(getPrincipal(request(google), env), null);
    assert.equal(getPrincipal(request(orcid), env), null);
    assert.equal(getPrincipal(request(signedIn), env)?.userId, 'abc123');
  }
  assert.equal(getPrincipal(request(orcid), { SIGNIN_PROVIDERS: 'github,aad,orcid' })?.userId, 'orcid:abc123');
  assert.equal(getPrincipal(request(google), { SIGNIN_PROVIDERS: 'github,aad,orcid' }), null);
  // GitHub and Microsoft are always accepted; unknown names add nothing.
  assert.deepEqual([...acceptedProviders({ SIGNIN_PROVIDERS: ' ORCID, facebook ' })].sort(), ['aad', 'github', 'orcid']);
});
