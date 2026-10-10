import assert from 'node:assert/strict';
import test from 'node:test';
import { createChannelProvider, createDelivery, normalizeProviderFailure, normalizeProviderSuccess } from '../../apps/api/src/delivery.js';

const notification = {
  notificationId: 'ntf_1',
  projectId: 'prj_1',
  organizationId: 'org_1',
  recipient: 'person@example.com',
};

test('creates an in-memory email delivery contract without changing notification storage', () => {
  assert.deepEqual(createDelivery(notification), {
    deliveryId: 'ntf_1:email',
    notificationId: 'ntf_1',
    projectId: 'prj_1',
    organizationId: 'org_1',
    channel: 'email',
    recipient: 'person@example.com',
    status: 'processing',
  });
});

test('normalizes successful provider responses through send', async () => {
  const provider = createChannelProvider({
    channel: 'email',
    provider: 'ses',
    send: async () => ({ MessageId: 'ses_123' }),
  });
  const result = await provider.send({ delivery: createDelivery(notification), content: { subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' } });
  assert.deepEqual(result, { outcome: 'success', provider: 'ses', providerMessageId: 'ses_123', metadata: {} });
});

test('normalizes transient provider failures as retryable', async () => {
  const provider = createChannelProvider({ channel: 'email', provider: 'ses', send: async () => { throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' }); } });
  const result = await provider.send({ delivery: createDelivery(notification), content: {} });
  assert.deepEqual(result, { outcome: 'failure', provider: 'ses', errorCode: 'ThrottlingException', errorMessage: 'throttled', retryable: true });
});

test('normalizes permanent provider failures as non-retryable', () => {
  const result = normalizeProviderFailure({ provider: 'ses', error: Object.assign(new Error('rejected'), { name: 'MessageRejected' }) });
  assert.deepEqual(result, { outcome: 'failure', provider: 'ses', errorCode: 'MessageRejected', errorMessage: 'rejected', retryable: false });
});

test('normalizes provider success values directly', () => {
  assert.deepEqual(normalizeProviderSuccess({ provider: 'ses', response: { providerMessageId: 'provider_123', metadata: { region: 'test' } } }), {
    outcome: 'success', provider: 'ses', providerMessageId: 'provider_123', metadata: { region: 'test' },
  });
});
