import assert from 'node:assert/strict';
import test from 'node:test';
import { listPendingCampaignRecipients, createCampaign, completeCampaignRecipient, setStoreClientForTests } from '../../apps/api/src/store.js';
import { handler, setWorkerDependenciesForTests } from '../../apps/api/src/worker.js';

function fakeCommandClient(responses) {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push(command);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response || {};
    },
  };
}

function campaign(overrides = {}) {
  return { projectId: 'prj_1', campaignId: 'cmp_1', state: 'running', channel: 'email', templateSlug: 'welcome', templateVersion: 1, organizationId: 'org_1', pending: 1, total: 1, processed: 0, successful: 0, failed: 0, ...overrides };
}

function workerHarness({ current = campaign(), recipients = [{ recipient: 'person@example.com' }], providerResult, recipientStatus, claim = { claimToken: 'claim-1' }, latest = current, onComplete } = {}) {
  let listCalls = 0;
  let campaignReads = 0;
  const queued = [];
  const restore = setWorkerDependenciesForTests({
    getCampaign: async () => { campaignReads += 1; return campaignReads <= 3 ? current : latest; },
    getTemplateVersion: async () => ({ subject: 'Hello', html: '<p>Hello</p>', text: 'Hello' }),
    listPendingCampaignRecipients: async () => (listCalls++ === 0 ? recipients : []),
    claimCampaignRecipient: async () => claim,
    getRecipient: async () => recipientStatus,
    completeCampaignRecipient: async (input) => onComplete?.(input),
    updateCampaignState: async (...args) => { onComplete?.({ stateUpdate: args }); },
    releaseCampaignRecipient: async (...args) => { onComplete?.({ release: args }); },
    disableDevice: async () => {},
    listDevices: async () => [],
    emailProvider: { send: async () => providerResult },
    sqs: { send: async (command) => queued.push(command) },
  });
  return { restore, queued };
}

test('listPendingCampaignRecipients scans later DynamoDB pages when earlier pages filter empty', async () => {
  const client = fakeCommandClient([
    { Items: [], LastEvaluatedKey: { PK: 'PROJECT#prj_1', SK: 'CAMPAIGN#cmp_1#RECIPIENT#a' } },
    { Items: [{ recipient: 'pending@example.com', status: 'pending' }] },
  ]);
  const restore = setStoreClientForTests(client);
  try {
    const items = await listPendingCampaignRecipients('prj_1', 'cmp_1', 25);
    assert.deepEqual(items, [{ recipient: 'pending@example.com', status: 'pending' }]);
    assert.equal(client.calls.length, 2);
    assert.deepEqual(client.calls[1].input.ExclusiveStartKey, { PK: 'PROJECT#prj_1', SK: 'CAMPAIGN#cmp_1#RECIPIENT#a' });
  } finally { restore(); }
});

test('completed records before pending records do not cause premature completion', async () => {
  const client = fakeCommandClient([
    { Items: [], LastEvaluatedKey: { PK: 'PROJECT#prj_1', SK: 'CAMPAIGN#cmp_1#RECIPIENT#completed' } },
    { Items: [{ recipient: 'pending@example.com', status: 'pending' }] },
  ]);
  const restore = setStoreClientForTests(client);
  try { assert.equal((await listPendingCampaignRecipients('prj_1', 'cmp_1', 1)).length, 1); } finally { restore(); }
});

test('partial recipient initialization marks the campaign failed instead of leaving it queued', async () => {
  const failure = new Error('DynamoDB unavailable');
  const client = fakeCommandClient([{}, {}, failure, {}]);
  const restore = setStoreClientForTests(client);
  try {
    await assert.rejects(() => createCampaign({
      campaign: { PK: 'PROJECT#prj_1', SK: 'CAMPAIGN#cmp_1', projectId: 'prj_1', campaignId: 'cmp_1', state: 'queued' },
      recipients: Array.from({ length: 91 }, (_, index) => `person${index}@example.com`),
    }), /DynamoDB unavailable/);
    const markFailed = client.calls.at(-1).input;
    assert.match(markFailed.UpdateExpression, /#state = :failed/);
    assert.equal(markFailed.ExpressionAttributeValues[':reason'], 'Campaign recipient initialization failed');
  } finally { restore(); }
});

test('completion transaction aliases counters and preserves counter invariants', async () => {
  const client = fakeCommandClient([{}]);
  const restore = setStoreClientForTests(client);
  try {
    await completeCampaignRecipient({ projectId: 'prj_1', campaignId: 'cmp_1', recipient: 'person@example.com', status: 'succeeded', providerMessageId: 'ses-1', claimToken: 'claim-1' });
    const transaction = client.calls[0].input.TransactItems;
    assert.match(transaction[1].Update.UpdateExpression, /#processed/);
    assert.doesNotMatch(transaction[1].Update.UpdateExpression, /SET processed\s/);
    assert.equal(transaction[0].Update.ExpressionAttributeValues[':providerMessageId'], 'ses-1');
    assert.equal(transaction[1].Update.ExpressionAttributeValues[':success'], 1);
    assert.equal(transaction[1].Update.ExpressionAttributeValues[':failure'], 0);
  } finally { restore(); }
});

test('worker does not complete a campaign when its counters still show pending work', async () => {
  const updates = [];
  const harness = workerHarness({ current: campaign({ pending: 1 }), recipients: [], latest: campaign({ pending: 1 }), onComplete: (event) => updates.push(event) });
  try { const result = await handler({ Records: [{ messageId: 'm1', body: JSON.stringify({ campaign: true, projectId: 'prj_1', campaignId: 'cmp_1' }) }] }); assert.deepEqual(result, { batchItemFailures: [] }); assert.equal(updates.length, 0); } finally { harness.restore(); }
});

test('successful SES acceptance stores the provider message id and completes counters', async () => {
  const completed = [];
  const harness = workerHarness({ providerResult: { outcome: 'success', provider: 'ses', providerMessageId: 'ses-message-1' }, onComplete: (event) => completed.push(event), latest: campaign({ pending: 0, processed: 1, successful: 1 }) });
  try { await handler({ Records: [{ messageId: 'm1', body: JSON.stringify({ campaign: true, projectId: 'prj_1', campaignId: 'cmp_1' }) }] }); assert.equal(completed.find((item) => item.status === 'succeeded').providerMessageId, 'ses-message-1'); assert.deepEqual(completed.find((item) => item.stateUpdate)?.stateUpdate.slice(-2), ['running', 'completed']); } finally { harness.restore(); }
});

test('SES MessageRejected marks the recipient failed with a sanitized reason', async () => {
  const completed = [];
  const harness = workerHarness({ providerResult: { outcome: 'failure', provider: 'ses', errorCode: 'MessageRejected', errorMessage: 'Email address person@example.com is not verified', retryable: false }, onComplete: (event) => completed.push(event), latest: campaign({ pending: 0, processed: 1, failed: 1 }) });
  try { await handler({ Records: [{ messageId: 'm1', body: JSON.stringify({ campaign: true, projectId: 'prj_1', campaignId: 'cmp_1' }) }] }); const failed = completed.find((item) => item.status === 'failed'); assert.match(failed.error, /^MessageRejected:/); assert.doesNotMatch(failed.error, /person@example.com/); } finally { harness.restore(); }
});

test('suppressed recipients are counted as failed without calling SES', async () => {
  const completed = [];
  const harness = workerHarness({ recipientStatus: { status: 'suppressed' }, providerResult: { outcome: 'success', providerMessageId: 'must-not-send' }, onComplete: (event) => completed.push(event), latest: campaign({ pending: 0, processed: 1, failed: 1 }) });
  try { await handler({ Records: [{ messageId: 'm1', body: JSON.stringify({ campaign: true, projectId: 'prj_1', campaignId: 'cmp_1' }) }] }); assert.equal(completed.find((item) => item.status === 'failed').error, 'suppressed'); } finally { harness.restore(); }
});

test('conditional completion failures are surfaced without applying a second counter update', async () => {
  const error = Object.assign(new Error('stale claim'), { name: 'ConditionalCheckFailedException' });
  const client = fakeCommandClient([error]);
  const restore = setStoreClientForTests(client);
  try { await assert.rejects(() => completeCampaignRecipient({ projectId: 'prj_1', campaignId: 'cmp_1', recipient: 'person@example.com', status: 'succeeded', providerMessageId: 'ses-1', claimToken: 'claim-1' }), /stale claim/); assert.equal(client.calls.length, 1); } finally { restore(); }
});

test('duplicate SQS delivery that loses the claim does not complete or double-count a recipient', async () => {
  const completed = [];
  const harness = workerHarness({ claim: null, onComplete: (event) => completed.push(event), latest: campaign({ pending: 1 }) });
  try { await handler({ Records: [{ messageId: 'm1', body: JSON.stringify({ campaign: true, projectId: 'prj_1', campaignId: 'cmp_1' }) }] }); assert.equal(completed.some((item) => item.status), false); assert.equal(harness.queued.length, 1); } finally { harness.restore(); }
});

test('dashboard maps backend campaign states and counters directly', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('../../apps/dashboard/app.js', import.meta.url), 'utf8');
  assert.match(source, /statusBadge\(c\.state\)/);
  assert.match(source, /c\.pending/);
  assert.match(source, /c\.successful/);
  assert.match(source, /c\.failed/);
});
