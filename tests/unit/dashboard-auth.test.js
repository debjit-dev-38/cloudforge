import assert from 'node:assert/strict';
import test from 'node:test';
import { createPkcePair, selectApiToken, tokenIsExpired } from '../../apps/dashboard/auth.js';

test('dashboard uses the Cognito ID token for the API JWT audience', () => {
  assert.equal(selectApiToken({ id_token: 'id-token', access_token: 'access-token' }), 'id-token');
  assert.equal(selectApiToken({ access_token: 'access-token' }), 'access-token');
  assert.equal(selectApiToken({}), null);
});

test('dashboard rejects expired or malformed JWTs', () => {
  const payload = Buffer.from(JSON.stringify({ exp: 100 }), 'utf8').toString('base64url');
  assert.equal(tokenIsExpired(`header.${payload}.signature`, 101000), true);
  assert.equal(tokenIsExpired('not-a-jwt'), true);
});

test('dashboard creates a PKCE verifier and S256 challenge', async () => {
  const pair = await createPkcePair();
  assert.match(pair.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(pair.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(pair.verifier, pair.challenge);
});
