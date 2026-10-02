import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpRequest, InvocationContext, type HttpResponseInit } from '@azure/functions';
import { API_SECURITY_HEADERS, assertSameOriginWrite, handle, HttpError, json, mediaType, noContent } from '../src/lib/http';
import { invocationLog } from '../src/lib/telemetry';

function request(method: string, headers: Record<string, string> = {}, body?: string): HttpRequest {
  return new HttpRequest({ method, url: 'https://example.org/api/projects', headers, body: body === undefined ? undefined : { string: body } });
}

/** Run a request through handle() with a handler that records whether it was reached. */
async function run(req: HttpRequest, inner: () => Promise<HttpResponseInit> = async () => json({ ok: true }, 201)) {
  let reached = false;
  const res = await handle(async () => { reached = true; return inner(); })(req, new InvocationContext());
  return { res, reached, headers: res.headers as Record<string, string> };
}

const JSON_BODY = '{"title":"x"}';

test('a text/plain POST is refused with 415 before the handler runs', async () => {
  const { res, reached } = await run(request('POST', { 'content-type': 'text/plain' }, JSON_BODY));
  assert.equal(res.status, 415);
  assert.equal(reached, false);
});

test('a form-urlencoded or multipart POST is refused with 415', async () => {
  for (const type of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
    const { res, reached } = await run(request('POST', { 'content-type': type }, 'a=b'));
    assert.equal(res.status, 415, type);
    assert.equal(reached, false, type);
  }
});

test('a POST with no Content-Type is refused, body or not', async () => {
  for (const body of [JSON_BODY, undefined]) {
    const { res, reached } = await run(request('POST', {}, body));
    assert.equal(res.status, 415);
    assert.equal(reached, false);
  }
});

test('PATCH, PUT and DELETE need application/json too, including a body-less DELETE', async () => {
  for (const method of ['PATCH', 'PUT', 'DELETE']) {
    assert.equal((await run(request(method))).res.status, 415, `${method} without a type`);
    assert.equal((await run(request(method, { 'content-type': 'application/json' }))).reached, true, `${method} with JSON`);
  }
});

test('a lookalike media type is refused', async () => {
  for (const type of ['application/jsonx', 'application/json-patch+json', 'text/json', 'application/ json']) {
    assert.equal((await run(request('POST', { 'content-type': type }, JSON_BODY))).res.status, 415, type);
  }
});

test('application/json is accepted with parameters and in any case', async () => {
  for (const type of ['application/json', 'application/json; charset=utf-8', 'Application/JSON;charset=UTF-8', ' application/json ']) {
    const { res, reached } = await run(request('POST', { 'content-type': type }, JSON_BODY));
    assert.equal(res.status, 201, type);
    assert.equal(reached, true, type);
  }
});

test('a cross-site or same-site Sec-Fetch-Site is refused with 403, even with a JSON body', async () => {
  for (const site of ['cross-site', 'same-site', 'none', 'Cross-Site']) {
    const { res, reached } = await run(request('POST', { 'content-type': 'application/json', 'sec-fetch-site': site }, JSON_BODY));
    assert.equal(res.status, 403, site);
    assert.equal(reached, false, site);
  }
  // A form, which is what this is for, is refused on its origin before its type is looked at.
  assert.equal((await run(request('POST', { 'content-type': 'text/plain', 'sec-fetch-site': 'cross-site' }, JSON_BODY))).res.status, 403);
});

test('a same-origin JSON request passes', async () => {
  const { res, reached } = await run(request('POST', { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, JSON_BODY));
  assert.equal(res.status, 201);
  assert.equal(reached, true);
});

test('a JSON request without Sec-Fetch-Site passes, as curl and older browsers send', async () => {
  const { res, reached } = await run(request('POST', { 'content-type': 'application/json' }, JSON_BODY));
  assert.equal(res.status, 201);
  assert.equal(reached, true);
});

test('GET and HEAD are not checked', async () => {
  for (const method of ['GET', 'HEAD']) {
    const { res, reached } = await run(request(method, { 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }), async () => json({ ok: true }));
    assert.equal(res.status, 200, method);
    assert.equal(reached, true, method);
  }
});

test('mediaType drops parameters, trims and lower-cases', () => {
  assert.equal(mediaType('Application/JSON; charset=utf-8'), 'application/json');
  assert.equal(mediaType(null), '');
  assert.doesNotThrow(() => assertSameOriginWrite(request('OPTIONS')));
});

test('every API response carries nosniff: success, refusals, handler errors and unexpected failures', async () => {
  assert.deepEqual(API_SECURITY_HEADERS, { 'x-content-type-options': 'nosniff' });
  assert.equal((json({}).headers as Record<string, string>)['x-content-type-options'], 'nosniff');
  assert.equal((noContent().headers as Record<string, string>)['x-content-type-options'], 'nosniff');
  // A handler's own header cannot take it off.
  assert.equal((json({}, 200, { 'x-content-type-options': 'off' }).headers as Record<string, string>)['x-content-type-options'], 'nosniff');
  const cases: [HttpRequest, () => Promise<HttpResponseInit>][] = [
    [request('GET'), async () => json({ ok: true })],
    [request('GET'), async () => ({ status: 200, body: 'x', headers: new Headers({ 'content-type': 'text/plain' }) })],
    [request('GET'), async () => ({ status: 204 })],
    [request('POST', { 'content-type': 'text/plain' }), async () => json({})],
    [request('GET'), async () => { throw new HttpError(404, 'Not found'); }],
    [request('GET'), async () => { throw new Error('boom'); }],
  ];
  for (const [req, inner] of cases) {
    const sink = { info: () => {}, warn: () => {}, error: () => {} };
    const { res, headers } = await invocationLog.run(sink, () => run(req, inner));
    assert.equal(headers['x-content-type-options'], 'nosniff', `on a ${res.status}`);
  }
});
