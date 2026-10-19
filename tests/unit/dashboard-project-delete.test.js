import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { handler, setDashboardClientForTests } from '../../apps/api/src/dashboard-api.js';
import { deleteProjectData, setStoreClientForTests } from '../../apps/api/src/store.js';

const projectId = 'prj_test';
const ownerId = 'user_test';
const projectKey = `PROJECT#${projectId}`;

function event(user = ownerId) {
  return {
    requestContext: {
      http: { method: 'DELETE' },
      requestId: 'request_test',
      authorizer: { jwt: { claims: { sub: user } } },
    },
    rawPath: `/v1/projects/${projectId}`,
    pathParameters: { projectId },
  };
}

function fakeClient({ records = [], projectOwner = ownerId, pages = false, failBatch = false, retryBatch = false } = {}) {
  const items = new Map(records.map((item) => [`${item.PK}|${item.SK}`, item]));
  items.set(`${projectKey}|META`, { PK: projectKey, SK: 'META', projectId, organizationId: 'org_test', ownerUserId: projectOwner });
  const calls = [];
  let batchAttempts = 0;
  return {
    calls,
    items,
    async send(command) {
      calls.push(command.input);
      if (command.input.KeyConditionExpression === 'PK = :pk') {
        const all = [...items.values()].filter((item) => item.PK === projectKey);
        if (!pages || !command.input.ExclusiveStartKey) return { Items: pages ? all.slice(0, 2) : all, ...(pages ? { LastEvaluatedKey: all[1] } : {}) };
        return { Items: all.slice(2) };
      }
      if (command.input.RequestItems) {
        batchAttempts += 1;
        if (failBatch) throw Object.assign(new Error('DynamoDB unavailable'), { name: 'ProvisionedThroughputExceededException' });
        const requests = command.input.RequestItems.NotificationTable || Object.values(command.input.RequestItems)[0];
        if (retryBatch && batchAttempts === 1) {
          for (const request of requests.slice(1)) items.delete(`${request.DeleteRequest.Key.PK}|${request.DeleteRequest.Key.SK}`);
          return { UnprocessedItems: { [Object.keys(command.input.RequestItems)[0]]: requests.slice(0, 1) } };
        }
        for (const request of requests) items.delete(`${request.DeleteRequest.Key.PK}|${request.DeleteRequest.Key.SK}`);
        return {};
      }
      if (command.input.Key?.SK === 'META' && command.input.UpdateExpression) return {};
      if (command.input.Key?.SK === 'META' && command.input.ConditionExpression) {
        items.delete(`${command.input.Key.PK}|${command.input.Key.SK}`);
        return {};
      }
      if (command.input.Key?.SK === 'META') return { Item: items.get(`${command.input.Key.PK}|META`) };
      if (command.input.KeyConditionExpression?.startsWith('PK = :pk')) return { Items: [] };
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

const projectRecords = [
  { PK: projectKey, SK: 'CAMPAIGN#cmp_1', projectId },
  { PK: projectKey, SK: 'CAMPAIGN#cmp_1#RECIPIENT#r1', projectId },
  { PK: projectKey, SK: 'NOTIFICATION#ntf_1', projectId },
  { PK: projectKey, SK: 'RECIPIENT#person@example.com', projectId },
  { PK: projectKey, SK: 'DEVICE#person@example.com#device', projectId },
  { PK: projectKey, SK: 'IDEMPOTENCY#idem_1', projectId },
  { PK: projectKey, SK: 'RATE#123', projectId },
  { PK: projectKey, SK: 'APIKEY#key_1', projectId, hash: 'hash_1' },
  { PK: projectKey, SK: 'TEMPLATE#custom#CURRENT', projectId, source: 'custom' },
  { PK: projectKey, SK: 'TEMPLATE#custom#V1', projectId, source: 'custom' },
  { PK: projectKey, SK: 'TEMPLATE#welcome-onboarding#CURRENT', projectId, source: 'system' },
  { PK: projectKey, SK: 'TEMPLATE#welcome-onboarding#V1', projectId, source: 'system' },
];

test('deletes an empty project and its metadata', async () => {
  const result = await withClient({}, async (client) => ({ response: await handler(event()), client }));
  assert.equal(result.response.statusCode, 200);
  assert.equal(JSON.parse(result.response.body).deleted, true);
  assert.equal(result.client.items.has(`${projectKey}|META`), false);
});

test('deletes project campaigns, notifications, history, keys, devices, and templates', async () => {
  const result = await withClient({ records: projectRecords }, async (client) => {
    await handler(event());
    return client;
  });
  assert.deepEqual([...result.items.values()].map((item) => item.PK), []);
  assert.ok(result.calls.some((input) => input.RequestItems));
});

test('preserves canonical definitions and classifies seeded versus custom templates explicitly', async () => {
  const defaults = await fs.readFile(new URL('../../apps/api/src/default-templates.js', import.meta.url), 'utf8');
  const store = await fs.readFile(new URL('../../apps/api/src/store.js', import.meta.url), 'utf8');
  assert.match(defaults, /source: 'system'/);
  assert.match(store, /source: definition\.source/);
  assert.match(store, /source: definition\.source, version/);
  assert.match(store, /deleteProjectData/);
});

test('deletes duplicate-name custom templates because ownership is project-scoped, not slug-scoped', async () => {
  const duplicate = { PK: projectKey, SK: 'TEMPLATE#welcome-onboarding#V1', projectId, source: 'custom' };
  const result = await withClient({ records: [duplicate] }, async (client) => {
    await deleteProjectData(projectId);
    return client;
  });
  assert.equal(result.items.size, 1);
  assert.equal(result.items.has(`${projectKey}|META`), true);
});

test('preserves another project by deleting only the target project partition', async () => {
  const other = { PK: 'PROJECT#other', SK: 'NOTIFICATION#ntf_other', projectId: 'other' };
  const result = await withClient({ records: [...projectRecords, other] }, async (client) => {
    await deleteProjectData(projectId);
    return client;
  });
  assert.deepEqual(result.items.get('PROJECT#other|NOTIFICATION#ntf_other'), other);
});

test('handles query pagination and retries unprocessed batch deletes', async () => {
  const result = await withClient({ records: projectRecords, pages: true, retryBatch: true }, async (client) => {
    await deleteProjectData(projectId);
    return client;
  });
  assert.equal(result.items.size, 1);
  assert.ok(result.calls.filter((input) => input.RequestItems).length >= 2);
});

test('reports partial cleanup failure without deleting metadata or claiming success', async () => {
  const result = await withClient({ records: projectRecords, failBatch: true }, async (client) => ({ response: await handler(event()), client }));
  assert.equal(result.response.statusCode, 503);
  assert.equal(JSON.parse(result.response.body).code, 'PROJECT_CLEANUP_FAILED');
  assert.equal(result.client.items.has(`${projectKey}|META`), true);
});

test('rejects deletion by an unauthorized user', async () => {
  const response = await withClient({ projectOwner: 'different-owner' }, async () => handler(event('outsider')));
  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).code, 'PROJECT_NOT_FOUND');
});

test('frontend warns about cascade scope and preserves actionable backend errors', async () => {
  const app = await fs.readFile(new URL('../../apps/dashboard/app.js', import.meta.url), 'utf8');
  assert.match(app, /all campaigns, notifications, delivery history, API keys, devices, custom templates, and template history/);
  assert.match(app, /built-in invoice-receipt, otp-verification, and welcome-onboarding templates/);
  assert.match(app, /The server could not complete this request\. Try again later\./);
});
