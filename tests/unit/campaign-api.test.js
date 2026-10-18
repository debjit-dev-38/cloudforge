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
