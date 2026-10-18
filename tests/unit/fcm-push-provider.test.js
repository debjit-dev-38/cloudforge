import assert from 'node:assert/strict';
import test from 'node:test';
import { createFcmPushProvider } from '../../apps/api/src/providers/fcm-push-provider.js';

const delivery = { notificationId: 'n1', projectId: 'p1', recipient: 'device-token-1234567890' };
const content = { title: 'Order ready', body: 'Your order is ready.', data: { orderId: '42' }, deepLink: 'https://example.test/orders/42' };

test('sends normalized FCM push content through a mocked client', async () => {
  const messages = [];
  const provider = createFcmPushProvider({ client: { sendMessage: async (message) => { messages.push(message); return { name: 'projects/demo/messages/123' }; } } });
  const result = await provider.send({ delivery, content });
  assert.deepEqual(messages, [{ token: delivery.recipient, notification: { title: content.title, body: content.body }, data: content.data, webpush: { fcmOptions: { link: content.deepLink } } }]);
  assert.deepEqual(result, { outcome: 'success', provider: 'fcm', providerMessageId: 'projects/demo/messages/123', metadata: { provider: 'fcm' } });
});

test('normalizes retryable FCM failures', async () => {
  const error = Object.assign(new Error('FCM temporarily unavailable'), { code: 'UNAVAILABLE', status: 503 });
  const provider = createFcmPushProvider({ client: { sendMessage: async () => { throw error; } } });
  assert.deepEqual(await provider.send({ delivery, content }), { outcome: 'failure', provider: 'fcm', errorCode: 'UNAVAILABLE', errorMessage: 'FCM temporarily unavailable', retryable: true });
});

test('normalizes invalid FCM tokens as permanent failures for disabling', async () => {
  const error = Object.assign(new Error('Requested entity was not found'), { code: 'UNREGISTERED', status: 404, disableToken: true });
  const provider = createFcmPushProvider({ client: { sendMessage: async () => { throw error; } } });
  assert.deepEqual(await provider.send({ delivery, content }), { outcome: 'failure', provider: 'fcm', errorCode: 'UNREGISTERED', errorMessage: 'Requested entity was not found', retryable: false, disableToken: true });
});

test('reports missing FCM configuration clearly', () => {
  assert.throws(() => createFcmPushProvider({ projectId: '', serviceAccountJson: '' }), /FCM_PROJECT_ID is required|Invalid FCM service account configuration/);
});
