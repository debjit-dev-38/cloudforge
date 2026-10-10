import assert from 'node:assert/strict';
import test from 'node:test';
import { campaignQueueMessage, deliveryChannels, normalizeCampaignRecipients, normalizePushContent } from '../../apps/api/src/delivery.js';

test('deduplicates and normalizes campaign recipients', () => {
  assert.deepEqual(normalizeCampaignRecipients({ channel: deliveryChannels.email, recipients: [' A@EXAMPLE.COM ', 'a@example.com', 'b@example.com'] }), ['a@example.com', 'b@example.com']);
  assert.deepEqual(normalizeCampaignRecipients({ channel: deliveryChannels.sms, recipients: ['+1 (415) 555-2671', '+14155552671'] }), ['+14155552671']);
});

test('rejects oversized campaign recipient lists and invalid push content', () => {
  assert.throws(() => normalizeCampaignRecipients({ recipients: [] }), /between 1 and 1000/);
  assert.throws(() => normalizeCampaignRecipients({ recipients: Array.from({ length: 1001 }, (_, index) => `a${index}@example.com`) }), /between 1 and 1000/);
  assert.throws(() => normalizePushContent({ title: 'x' }), /title and push\.body/);
});

test('builds campaign queue messages with the exact campaign id', () => {
  assert.equal(campaignQueueMessage('project-1', 'campaign-42'), JSON.stringify({ projectId: 'project-1', campaignId: 'campaign-42', campaign: true }));
});
