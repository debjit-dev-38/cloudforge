import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCampaignPayload,
  buildNotificationPayload,
  buildPushPayload,
  buildScheduledAt,
  maskToken,
  parseObjectJson,
  parseRecipients,
} from '../../apps/dashboard/form-utils.js';

test('builds email, SMS, and push notification payloads', () => {
  assert.deepEqual(buildNotificationPayload({ template: 'welcome', channel: 'email', recipient: 'A@EXAMPLE.COM', data: { name: 'A' } }), {
    template: 'welcome', channel: 'email', recipient: 'a@example.com', data: { name: 'A' },
  });
  assert.equal(buildNotificationPayload({ template: 'otp', channel: 'sms', recipient: '+1 (415) 555-2671', data: {} }).recipient, '+14155552671');
  const push = buildPushPayload({ title: ' Hello ', body: ' World ', deepLink: '', data: { id: 42 } });
  assert.deepEqual(buildNotificationPayload({ template: 'alert', channel: 'push', recipient: 'user@example.com', data: {}, push }), {
    template: 'alert', channel: 'push', recipient: 'user@example.com', data: {}, push: { title: 'Hello', body: 'World', data: { id: 42 } },
  });
});

test('builds campaign payloads with one normalized channel and deduplicated recipients', () => {
  assert.deepEqual(buildCampaignPayload({ template: 'welcome', channel: 'email', recipients: 'A@EXAMPLE.COM, a@example.com\nb@example.com', data: { name: 'Member' } }), {
    template: 'welcome', channel: 'email', recipients: ['a@example.com', 'b@example.com'], data: { name: 'Member' },
  });
  assert.deepEqual(parseRecipients('sms', '+1 (415) 555-2671\n+14155552671'), ['+14155552671']);
});

test('requires and preserves ordered DLT variable mappings for SMS campaigns', () => {
  assert.deepEqual(buildCampaignPayload({ template: 'otp', channel: 'sms', recipients: '+919876543210', data: { otp: '1234', name: 'Asha' }, dltVariableMapping: ['otp', 'name'] }).dltVariableMapping, ['otp', 'name']);
  assert.throws(() => buildCampaignPayload({ template: 'otp', channel: 'sms', recipients: '+919876543210', data: { otp: '1234' }, dltVariableMapping: [] }), /DLT variable mapping/);
});

test('validates campaign limits, channel-specific recipients, and JSON', () => {
  assert.throws(() => parseRecipients('email', 'bad'), /valid recipient email/);
  assert.throws(() => parseRecipients('sms', '4155552671'), /E\.164/);
  assert.throws(() => parseRecipients('email', Array.from({ length: 1001 }, (_, i) => `user${i}@example.com`).join(',')), /1,000/);
  assert.throws(() => parseObjectJson('{bad', 'Push custom data'), /valid JSON/);
  assert.throws(() => parseObjectJson('[]', 'Template variables data'), /JSON object/);
  assert.throws(() => buildPushPayload({ title: '', body: 'body', deepLink: '', data: {} }), /title and body/);
});

test('masks device tokens without exposing the full token', () => {
  assert.equal(maskToken('abcdefghijklmnopqrstuvwxyz'), 'abcd...wxyz');
});

test('converts future local schedule input to UTC and rejects stale input', () => {
  const scheduledAt = buildScheduledAt('2099-01-02', '03:04', Date.parse('2099-01-01T00:00:00Z'));
  assert.equal(scheduledAt, new Date('2099-01-02T03:04').toISOString());
  assert.throws(() => buildScheduledAt('2020-01-02', '03:04', Date.parse('2020-01-02T03:05:00Z')), /future/);
  assert.throws(() => buildScheduledAt('', '', Date.now()), /date and time/);
});

test('includes an optional schedule without changing immediate campaign payloads', () => {
  const immediate = buildCampaignPayload({ template: 'welcome', channel: 'email', recipients: 'a@example.com', data: {} });
  assert.equal('scheduledAt' in immediate, false);
  const scheduled = buildCampaignPayload({ template: 'welcome', channel: 'email', recipients: 'a@example.com', data: {}, scheduledAt: '2099-01-02T03:04:00.000Z' });
  assert.equal(scheduled.scheduledAt, '2099-01-02T03:04:00.000Z');
});
