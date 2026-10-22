import { expect, test } from 'vitest';
import { fakeServer, offline } from '../test/fixtures';
import { api, ApiError, NetworkError } from './client';

test('sends credentials and JSON, returns the parsed body', async () => {
  const { requests } = fakeServer({ 'POST /api/things': () => ({ status: 201, body: { ok: true } }) });
  await expect(api('POST', '/things', { body: { a: 1 }, auth: { token: 't', session: 's' } })).resolves.toEqual({ ok: true });
  expect(requests[0]!.headers).toMatchObject({ Authorization: 'Bearer t', 'X-Session': 's', 'Content-Type': 'application/json' });
  expect(requests[0]!.body).toEqual({ a: 1 });
});

test('turns error responses into ApiError with the server code', async () => {
  fakeServer({ 'GET /api/x': () => ({ status: 409, body: { code: 'conflict', message: 'changed', details: [1] } }) });
  const err = await api('GET', '/x').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err).toMatchObject({ status: 409, code: 'conflict', message: 'changed', details: [1] });
});

test('a failed fetch or a dead gateway is a NetworkError', async () => {
  fakeServer({ 'GET /api/down': offline, 'GET /api/gateway': () => ({ status: 502 }) });
  await expect(api('GET', '/down')).rejects.toBeInstanceOf(NetworkError);
  await expect(api('GET', '/gateway')).rejects.toBeInstanceOf(NetworkError);
});

test('204 resolves to undefined', async () => {
  fakeServer({ 'DELETE /api/sessions': () => ({ status: 204 }) });
  await expect(api('DELETE', '/sessions')).resolves.toBeUndefined();
});
