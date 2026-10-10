import assert from 'node:assert/strict';
import test from 'node:test';
import { apiKeyHash, canTransition, createUnsubscribeToken, decodeCursor, deliveryFailureStatus, encodeCursor, isRetryableProviderError, renderTemplate, templateVariables, validateEmail, verifyUnsubscribeToken } from '../../apps/api/src/core.js';

test('renders only declared variables and escapes HTML values', () => {
  assert.deepEqual(templateVariables('Hi {{user.name}} — {{code}}'), ['user.name', 'code']);
  assert.equal(renderTemplate('Hi {{user.name}}', { user: { name: '<Sam>' } }), 'Hi &lt;Sam&gt;');
  assert.throws(() => renderTemplate('Hi {{name}}', {}), /Missing template variable/);
});

test('normalizes recipient addresses and rejects malformed values', () => {
  assert.equal(validateEmail(' Person@Example.com '), 'person@example.com');
  assert.throws(() => validateEmail('not-an-email'), /valid email/);
});

test('key hashes are deterministic without storing raw credentials', () => {
  assert.equal(apiKeyHash('nfy_secret', 'pepper'), apiKeyHash('nfy_secret', 'pepper'));
  assert.notEqual(apiKeyHash('nfy_secret', 'pepper'), apiKeyHash('nfy_other', 'pepper'));
});

test('terminal delivery states cannot be overwritten by stale feedback', () => {
  assert.equal(canTransition('sent', 'delivered'), true);
  assert.equal(canTransition('bounced', 'delivered'), false);
  assert.equal(canTransition('delivered', 'bounced'), true);
});

test('transient provider failures are retryable but permanent rejections are not', () => {
  assert.equal(isRetryableProviderError({ name: 'ThrottlingException' }), true);
  assert.equal(isRetryableProviderError({ $metadata: { httpStatusCode: 503 } }), true);
  assert.equal(isRetryableProviderError({ name: 'MessageRejected' }), false);
  assert.equal(deliveryFailureStatus({ name: 'ThrottlingException' }), 'queued');
  assert.equal(deliveryFailureStatus({ name: 'MessageRejected' }), 'failed');
});

test('unsubscribe tokens are signed, scoped, and expire', () => {
  const token = createUnsubscribeToken({ projectId: 'prj_1', email: ' Person@Example.com ', expiresAt: 2_000 }, 'secret');
  assert.deepEqual(verifyUnsubscribeToken(token, 'secret', 1_999), { projectId: 'prj_1', email: 'person@example.com', expiresAt: 2_000 });
  assert.throws(() => verifyUnsubscribeToken(`${token}tampered`, 'secret', 1_999), /valid unsubscribe token/);
  assert.throws(() => verifyUnsubscribeToken(token, 'secret', 2_000), /valid unsubscribe token/);
});

test('pagination cursors round-trip and reject malformed values', () => {
  const key = { PK: 'PROJECT#prj_1', SK: 'NOTIFICATION#ntf_1' };
  assert.deepEqual(decodeCursor(encodeCursor(key)), key);
  assert.throws(() => decodeCursor('not-a-cursor'), /valid pagination cursor/);
});
