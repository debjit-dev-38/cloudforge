import assert from 'node:assert/strict';
import test from 'node:test';

// These tests exercise the request boundary without AWS calls. OPTIONS returns
// before DynamoDB/API-key access; protected methods fail before any AWS call when
// credentials are absent or invalid in the handler's authorization path.
const event = (method, overrides = {}) => ({
  requestContext: { http: { method } },
  headers: {},
  rawPath: '/v1/campaigns',
  ...overrides,
});

test('campaign preflight does not require an API key', async () => {
  const { handler } = await import('../../apps/api/src/campaign-api.js');
  const response = await handler(event('OPTIONS'));
  assert.equal(response.statusCode, 204);
});

test('campaign GET without an API key is rejected', async () => {
  const { handler } = await import('../../apps/api/src/campaign-api.js');
  const response = await handler(event('GET'));
  assert.equal(response.statusCode, 401);
  assert.equal(JSON.parse(response.body).code, 'API_KEY_REQUIRED');
});

test('campaign POST without an API key is rejected', async () => {
  const { handler } = await import('../../apps/api/src/campaign-api.js');
  const response = await handler(event('POST'));
  assert.equal(response.statusCode, 401);
  assert.equal(JSON.parse(response.body).code, 'API_KEY_REQUIRED');
});

test('campaign invalid API keys are rejected before business logic', async () => {
  const { authorize } = await import('../../apps/api/src/campaign-api.js');
  await assert.rejects(
    authorize(event('GET', { headers: { 'x-api-key': 'nfy_invalid' } }), async () => undefined),
    (error) => error.statusCode === 401 && error.code === 'INVALID_API_KEY',
  );
});

test('valid campaign API keys resolve to the owning project', async () => {
  const { authorize } = await import('../../apps/api/src/campaign-api.js');
  const result = await authorize(
    event('GET', { headers: { 'x-api-key': 'nfy_valid' } }),
    async () => ({ projectId: 'project-1', organizationId: 'org-1', maxPerMinute: 60 }),
  );
  assert.deepEqual(result, { projectId: 'project-1', organizationId: 'org-1', maxPerMinute: 60 });
});

test('validates scheduled campaign timestamps and normalizes them to UTC', async () => {
  const { validateScheduledAt } = await import('../../apps/api/src/campaign-api.js');
  assert.equal(validateScheduledAt('2099-01-02T03:04:05+05:30'), '2099-01-01T21:34:05.000Z');
  assert.throws(() => validateScheduledAt('2099-01-02T03:04:05'), /explicit timezone/);
  assert.throws(() => validateScheduledAt('2000-01-02T03:04:05Z'), /future/);
});

test('scheduled start is conditional and ignores cancelled or duplicate invocations', async () => {
  const { startCampaign, setCampaignStartDependenciesForTests } = await import('../../apps/api/src/campaign-api.js');
  const updates = [];
  const messages = [];
  const restore = setCampaignStartDependenciesForTests({
    getCampaign: async () => ({ campaignId: 'cmp_1', projectId: 'prj_1', state: 'scheduled', scheduledAt: '2000-01-01T00:00:00.000Z' }),
    updateCampaignState: async (...args) => updates.push(args),
    sqs: { send: async (message) => messages.push(message) },
  });
  try {
    assert.deepEqual(await startCampaign({ projectId: 'prj_1', campaignId: 'cmp_1' }), { started: true, campaignId: 'cmp_1' });
    assert.equal(updates.length, 1);
    assert.equal(messages.length, 1);
  } finally { restore(); }

  const cancelledRestore = setCampaignStartDependenciesForTests({
    getCampaign: async () => ({ state: 'cancelled', scheduledAt: '2000-01-01T00:00:00.000Z' }),
  });
  try {
    assert.deepEqual(await startCampaign({ projectId: 'prj_1', campaignId: 'cmp_1' }), { started: false, reason: 'not-eligible' });
  } finally { cancelledRestore(); }
});
