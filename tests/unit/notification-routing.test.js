import assert from 'node:assert/strict';
import test from 'node:test';
import { deliveryChannels, normalizeChannelAndRecipient, normalizePushContent, queueMessage, selectProvider } from '../../apps/api/src/delivery.js';

test('defaults to email and preserves existing recipient normalization', () => {
  assert.deepEqual(normalizeChannelAndRecipient({ recipient: ' PERSON@Example.COM ' }), {
    channel: deliveryChannels.email, recipient: 'person@example.com',
  });
});

test('validates and normalizes SMS recipients before queueing', () => {
  assert.deepEqual(normalizeChannelAndRecipient({ channel: 'sms', recipient: '+1 (415) 555-2671' }), {
    channel: deliveryChannels.sms, recipient: '+14155552671',
  });
  assert.throws(() => normalizeChannelAndRecipient({ channel: 'sms', recipient: '4155552671' }), /E\.164/);
  assert.throws(() => normalizeChannelAndRecipient({ channel: 'fax', recipient: '+14155552671' }), /email, sms, or push/);
});

test('keeps legacy email queue messages and marks SMS queue messages', () => {
  assert.equal(queueMessage('p1', 'n1'), JSON.stringify({ projectId: 'p1', notificationId: 'n1' }));
  assert.equal(queueMessage('p1', 'n2', 'sms'), JSON.stringify({ projectId: 'p1', notificationId: 'n2', channel: 'sms' }));
});

test('routes each channel to only its matching provider', () => {
  const email = { channel: 'email' };
  const sms = { channel: 'sms' };
  assert.equal(selectProvider('email', { email, sms }), email);
  assert.equal(selectProvider('sms', { email, sms }), sms);
  const push = { channel: 'push' };
  assert.equal(selectProvider('push', { email, sms, push }), push);
});

test('normalizes push content without changing email or SMS inputs', () => {
  assert.deepEqual(normalizePushContent({ title: ' Hello ', body: ' World ', data: { orderId: 42 }, deepLink: 'https://example.test/orders/42' }), {
    title: 'Hello', body: 'World', data: { orderId: '42' }, deepLink: 'https://example.test/orders/42',
  });
  assert.throws(() => normalizePushContent({ title: 'Only title' }), /title and push\.body/);
});
