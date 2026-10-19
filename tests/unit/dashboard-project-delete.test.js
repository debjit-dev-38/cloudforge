import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { handler, setDashboardClientForTests } from '../../apps/api/src/dashboard-api.js';
import { setStoreClientForTests } from '../../apps/api/src/store.js';

const projectId = 'prj_test';
const ownerId = 'user_test';

function event() {
  return {
    requestContext: {
      http: { method: 'DELETE' },
      requestId: 'request_test',
      authorizer: { jwt: { claims: { sub: ownerId } } },
    },
    rawPath: `/v1/projects/${projectId}`,
    pathParameters: { projectId },
  };
}

function fakeClient({ dependentItems = [], project = true, queryError } = {}) {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push(command.input);
      if (command.input.Key?.SK === 'META') return { Item: project ? {
        PK: `PROJECT#${projectId}`,
        SK: 'META',
        projectId,
        organizationId: 'org_test',
        ownerUserId: ownerId,
      } : undefined };
      if (command.input.KeyConditionExpression === 'PK = :pk') {
        if (queryError) throw queryError;
        return { Items: [{ SK: 'META' }, ...dependentItems] };
      }
      if (command.input.Key?.SK === 'META') return { Item: undefined };
      return {};
    },
  };
}

async function withClient(options, callback) {
  const client = fakeClient(options);
  const restoreDashboard = setDashboardClientForTests(client);
  const restoreStore = setStoreClientForTests(client);
  try {
    return await callback(client);
  } finally {
    restoreDashboard();
    restoreStore();
  }
}

test('deletes an empty project after checking its partition', async () => {
  const result = await withClient({}, async (client) => ({ response: await handler(event()), client }));
  const { response, client } = result;
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { projectId, deleted: true });
  assert.equal(client.calls.filter((call) => call.Key?.SK === 'META').length, 3);
  assert.equal(client.calls.at(-1).Key.SK, 'META');
});

test('blocks deletion when the project has dependent records', async () => {
  const result = await withClient({ dependentItems: [{ SK: 'TEMPLATE#welcome#CURRENT' }] }, async (client) => ({ response: await handler(event()), client }));
  const { response, client } = result;
  assert.equal(response.statusCode, 409);
  assert.equal(JSON.parse(response.body).code, 'PROJECT_HAS_DEPENDENCIES');
  assert.equal(client.calls.some((call) => call.Key?.SK === 'META' && call.ConditionExpression), false);
  assert.equal(client.calls.at(-1).KeyConditionExpression, 'PK = :pk');
  assert.equal(client.calls.at(-1).FilterExpression, undefined);
});

test('returns not found for a nonexistent project', async () => {
  const response = await withClient({ project: false }, async () => handler(event()));
  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).code, 'PROJECT_NOT_FOUND');
});

test('returns a structured backend error when the dependency query fails', async () => {
  const response = await withClient({ queryError: Object.assign(new Error('DynamoDB unavailable'), { name: 'ProvisionedThroughputExceededException' }) }, async () => handler(event()));
  assert.equal(response.statusCode, 500);
  assert.deepEqual(JSON.parse(response.body), {
    error: 'Internal error',
    code: 'INTERNAL_ERROR',
    requestId: 'request_test',
  });
});

test('frontend maps backend failures to an actionable message instead of only Internal error', async () => {
  const app = await fs.readFile(new URL('../../apps/dashboard/app.js', import.meta.url), 'utf8');
  assert.match(app, /The server could not complete this request\. Try again later\./);
  assert.match(app, /Request ID: \$\{err\.requestId\}/);
});
