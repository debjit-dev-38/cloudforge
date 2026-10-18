import assert from 'node:assert/strict';
import test from 'node:test';
import { createFast2SmsProvider, normalizeIndianMobile } from '../../apps/api/src/providers/fast2sms-provider.js';

const delivery = { recipient: '+91 9876543210' };
const content = { data: { otp: '1234', name: 'Asha' }, dltVariableMapping: ['otp', 'name'] };

test('Fast2SMS mock mode makes no request and returns simulated', async () => {
  let calls = 0;
  const provider = createFast2SmsProvider({ senderId: 'TESTID', templateId: '123456', mockMode: true, fetchImpl: async () => { calls += 1; } });
  assert.equal((await provider.send({ delivery, content })).outcome, 'simulated');
  assert.equal(calls, 0);
});

test('validates Indian numbers and required variables', async () => {
  assert.equal(normalizeIndianMobile('+91 9876543210'), '9876543210');
  assert.throws(() => normalizeIndianMobile('+1 4155552671'), /Indian mobile/);
  const provider = createFast2SmsProvider({ senderId: 'TESTID', templateId: '123456', mockMode: true });
  await assert.rejects(() => provider.send({ delivery, content: { data: {}, dltVariableMapping: ['otp'] } }), /variable/);
});

test('sends the documented DLT payload and validates acceptance', async () => {
  let request;
  const provider = createFast2SmsProvider({ apiKey: 'secret', senderId: 'SENDER', templateId: '123456', mockMode: false, fetchImpl: async (...args) => { request = args; return new Response(JSON.stringify({ return: true, request_id: 'req-1' }), { status: 200 }); } });
  const result = await provider.send({ delivery, content });
  assert.equal(result.providerMessageId, 'req-1');
  assert.deepEqual(JSON.parse(request[1].body), { sender_id: 'SENDER', message: '123456', variables_values: '1234|Asha', route: 'dlt', numbers: '9876543210', sms_details: '1' });
});

test('normalizes rejection, HTTP errors, and timeout as failures for worker retry handling', async () => {
  const rejected = createFast2SmsProvider({ apiKey: 'secret', senderId: 'SENDER', templateId: '123456', mockMode: false, fetchImpl: async () => new Response(JSON.stringify({ return: false, message: 'rejected' }), { status: 200 }) });
  await assert.rejects(() => rejected.send({ delivery, content }), /rejected/);
  const httpError = createFast2SmsProvider({ apiKey: 'secret', senderId: 'SENDER', templateId: '123456', mockMode: false, fetchImpl: async () => new Response('{}', { status: 429 }) });
  await assert.rejects(() => httpError.send({ delivery, content }), (error) => error.retryable === true);
});
