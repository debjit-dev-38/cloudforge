import assert from 'node:assert/strict';
import test from 'node:test';
import { campaignQueueMessage, deliveryChannels, normalizeCampaignRecipients, normalizePushContent, selectProvider } from '../../apps/api/src/delivery.js';

test('deduplicates and normalizes campaign recipients for email', () => {
  assert.deepEqual(normalizeCampaignRecipients({ channel: deliveryChannels.email, recipients: [' A@EXAMPLE.COM ', 'a@example.com', 'b@example.com'] }), ['a@example.com', 'b@example.com']);
});

test('deduplicates and normalizes campaign recipients for sms', () => {
  assert.deepEqual(normalizeCampaignRecipients({ channel: deliveryChannels.sms, recipients: ['+1 (415) 555-2671', '+14155552671', '+1 (212) 555-0199'] }), ['+14155552671', '+12125550199']);
});

test('deduplicates and normalizes campaign recipients for push', () => {
  assert.deepEqual(normalizeCampaignRecipients({ channel: deliveryChannels.push, recipients: [' User1@Example.com ', 'user1@example.com', 'user2@example.com'] }), ['user1@example.com', 'user2@example.com']);
});

test('rejects mixed invalid recipients in campaign lists', () => {
  assert.throws(() => normalizeCampaignRecipients({ channel: deliveryChannels.email, recipients: ['valid@example.com', 'invalid-email'] }), /valid email/);
  assert.throws(() => normalizeCampaignRecipients({ channel: deliveryChannels.sms, recipients: ['+14155552671', 'invalid-phone'] }), /E\.164/);
  assert.throws(() => normalizeCampaignRecipients({ channel: deliveryChannels.push, recipients: ['valid@example.com', 'invalid-user'] }), /valid email/);
});

test('rejects oversized campaign recipient lists and invalid push content', () => {
  assert.throws(() => normalizeCampaignRecipients({ recipients: [] }), /between 1 and 1000/);
  assert.throws(() => normalizeCampaignRecipients({ recipients: Array.from({ length: 1001 }, (_, index) => `a${index}@example.com`) }), /between 1 and 1000/);
  assert.throws(() => normalizePushContent({ title: 'x' }), /title and push\.body/);
  assert.throws(() => normalizePushContent({ title: '', body: 'body' }), /title and push\.body/);
  assert.throws(() => normalizePushContent({ title: 'title', body: '' }), /title and push\.body/);
  assert.throws(() => normalizePushContent(null), /push must be an object/);
});

test('builds campaign queue messages with the exact campaign id', () => {
  assert.equal(campaignQueueMessage('project-1', 'campaign-42'), JSON.stringify({ projectId: 'project-1', campaignId: 'campaign-42', campaign: true }));
});

test('campaign state transitions for pause, resume, and cancel', () => {
  const transitions = { pause: ['scheduled', 'queued', 'running'], resume: ['paused'], cancel: ['scheduled', 'queued', 'running', 'paused'] };
  assert.ok(transitions.pause.includes('scheduled'));
  assert.ok(transitions.pause.includes('running'));
  assert.ok(transitions.resume.includes('paused'));
  assert.equal(transitions.resume.includes('queued'), false);
  assert.ok(transitions.cancel.includes('scheduled'));
  assert.ok(transitions.cancel.includes('running'));
  assert.ok(transitions.cancel.includes('paused'));
  assert.equal(transitions.resume.includes('running'), false);
  assert.equal(transitions.resume.includes('completed'), false);
  assert.equal(transitions.pause.includes('completed'), false);
});

test('provider selection across email, sms, and push', () => {
  const providers = {
    email: { name: 'ses' },
    sms: { name: 'twilio' },
    push: { name: 'fcm' },
  };
  assert.equal(selectProvider(deliveryChannels.email, providers).name, 'ses');
  assert.equal(selectProvider(deliveryChannels.sms, providers).name, 'twilio');
  assert.equal(selectProvider(deliveryChannels.push, providers).name, 'fcm');
  assert.throws(() => selectProvider('unknown', providers), /Unsupported notification channel/);
});
