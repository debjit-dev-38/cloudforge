import assert from 'node:assert/strict';
import test from 'node:test';
import { listCampaigns, setStoreClientForTests } from '../../apps/api/src/store.js';

test('campaign listing returns parent campaigns and excludes recipient child records', async () => {
  const parent = { PK: 'PROJECT#p1', SK: 'CAMPAIGN#cmp_1', campaignId: 'cmp_1', templateSlug: 'cloud-forge', state: 'completed', total: 2, processed: 2 };
  const child = { PK: 'PROJECT#p1', SK: 'CAMPAIGN#cmp_1#RECIPIENT#abc', campaignId: 'cmp_1', recipient: 'redacted@example.com', status: 'succeeded' };
  const client = {
    calls: [],
    async send(command) {
      this.calls.push(command.input);
      return { Items: [parent], LastEvaluatedKey: undefined };
    },
  };
  const restore = setStoreClientForTests(client);
  try {
    const result = await listCampaigns('p1');
    assert.deepEqual(result.Items, [parent]);
    assert.equal(client.calls[0].FilterExpression, 'attribute_not_exists(recipient)');
  } finally {
    restore();
  }
});

test('campaign listing paginates past recipient-only query pages', async () => {
  const parent = { PK: 'PROJECT#p1', SK: 'CAMPAIGN#cmp_2', campaignId: 'cmp_2', state: 'completed', total: 1, processed: 1 };
  let calls = 0;
  const client = {
    async send(command) {
      calls += 1;
      return calls === 1
        ? { Items: [], LastEvaluatedKey: { PK: 'PROJECT#p1', SK: 'CAMPAIGN#cmp_1#RECIPIENT#abc' } }
        : { Items: [parent], LastEvaluatedKey: undefined };
    },
  };
  const restore = setStoreClientForTests(client);
  try {
    const result = await listCampaigns('p1');
    assert.deepEqual(result.Items, [parent]);
    assert.equal(calls, 2);
  } finally {
    restore();
  }
});
