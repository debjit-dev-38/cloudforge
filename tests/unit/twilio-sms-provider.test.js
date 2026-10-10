import test from 'node:test';
import assert from 'node:assert/strict';
import { createTwilioSmsProvider, normalizePhoneNumber } from '../../apps/api/src/providers/twilio-sms-provider.js';

const delivery = { notificationId: 'n1', projectId: 'p1', recipient: '+1 (415) 555-2671' };
const content = { text: 'Your notification is ready.' };

test('normalizes supported phone formats to E.164', () => {
  assert.equal(normalizePhoneNumber('+1 (415) 555-2671'), '+14155552671');
  assert.equal(normalizePhoneNumber('0044 20 7946 0958'), '+442079460958');
});

test('rejects phone numbers without a country code', () => {
  assert.throws(() => normalizePhoneNumber('4155552671'), /E\.164/);
  assert.throws(() => normalizePhoneNumber('+0123456789'), /E\.164/);
});

test('normalizes a successful Twilio response', async () => {
  const calls = [];
  const provider = createTwilioSmsProvider({
    fromNumber: '+15005550006',
    client: { messages: { create: async (input) => { calls.push(input); return { sid: 'SM123', status: 'queued' }; } } },
  });
  const result = await provider.send({ delivery, content });
  assert.deepEqual(calls, [{ from: '+15005550006', to: '+14155552671', body: content.text }]);
  assert.deepEqual(result, { outcome: 'success', provider: 'twilio', providerMessageId: 'SM123', metadata: { status: 'queued', errorCode: null } });
});

test('normalizes retryable Twilio failures', async () => {
  const error = Object.assign(new Error('Twilio is throttling requests'), { code: 30001, status: 429 });
  const provider = createTwilioSmsProvider({ fromNumber: '+15005550006', client: { messages: { create: async () => { throw error; } } } });
  assert.deepEqual(await provider.send({ delivery, content }), { outcome: 'failure', provider: 'twilio', errorCode: 30001, errorMessage: 'Twilio is throttling requests', retryable: true });
});

test('normalizes permanent Twilio failures', async () => {
  const error = Object.assign(new Error('The destination number is unreachable'), { code: '30003', status: 400 });
  const provider = createTwilioSmsProvider({ fromNumber: '+15005550006', client: { messages: { create: async () => { throw error; } } } });
  assert.deepEqual(await provider.send({ delivery, content }), { outcome: 'failure', provider: 'twilio', errorCode: '30003', errorMessage: 'The destination number is unreachable', retryable: false });
});
