import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { getTemplate, listTemplates, setStoreClientForTests } from '../../apps/api/src/store.js';

function fakeTemplateClient(items) {
  const byKey = new Map(items.map((item) => [`${item.PK}|${item.SK}`, item]));
  return {
    calls: [],
    async send(command) {
      this.calls.push(command.input);
      if (command.input.Key) return { Item: byKey.get(`${command.input.Key.PK}|${command.input.Key.SK}`) };
      return { Items: items.filter((item) => item.PK === command.input.ExpressionAttributeValues[':pk'] && item.SK.startsWith('TEMPLATE#')) };
    },
  };
}

test('template listing resolves current pointers and excludes pointer records', async () => {
  const items = [
    { PK: 'PROJECT#p1', SK: 'TEMPLATE#draft#CURRENT', version: 1, state: 'draft' },
    { PK: 'PROJECT#p1', SK: 'TEMPLATE#draft#V1', projectId: 'p1', slug: 'draft', version: 1, state: 'draft' },
    { PK: 'PROJECT#p1', SK: 'TEMPLATE#published#CURRENT', version: 2, state: 'published' },
    { PK: 'PROJECT#p1', SK: 'TEMPLATE#published#V2', projectId: 'p1', slug: 'published', version: 2, state: 'published' },
    { PK: 'PROJECT#p1', SK: 'TEMPLATE#orphan#CURRENT', version: 1, state: 'published' },
    { PK: 'PROJECT#p1', SK: 'TEMPLATE#orphan#V2', projectId: 'p1', slug: 'orphan', version: 2, state: 'published' },
    { PK: 'PROJECT#p2', SK: 'TEMPLATE#other#CURRENT', version: 1, state: 'published' },
    { PK: 'PROJECT#p2', SK: 'TEMPLATE#other#V1', projectId: 'p2', slug: 'other', version: 1, state: 'published' },
  ];
  const client = fakeTemplateClient(items);
  const restore = setStoreClientForTests(client);
  try {
    assert.deepEqual(await listTemplates('p1'), [
      items[0 + 1],
      items[2 + 1],
    ]);
    assert.equal(client.calls.filter((call) => call.Key).every((call) => call.Key.PK === 'PROJECT#p1'), true);
  } finally {
    restore();
  }
});

test('template lookup is project-scoped and preserves draft versus published state', async () => {
  const items = [
    { PK: 'PROJECT#p1', SK: 'TEMPLATE#welcome#CURRENT', version: 1, state: 'draft' },
    { PK: 'PROJECT#p1', SK: 'TEMPLATE#welcome#V1', projectId: 'p1', slug: 'welcome', version: 1, state: 'draft' },
  ];
  const restore = setStoreClientForTests(fakeTemplateClient(items));
  try {
    assert.equal((await getTemplate('p1', 'welcome')).state, 'draft');
    assert.equal(await getTemplate('p2', 'welcome'), undefined);
  } finally {
    restore();
  }
});

test('template creation persists the version and current pointer in one project-scoped transaction', async () => {
  const dashboardApi = await fs.readFile(new URL('../../apps/api/src/dashboard-api.js', import.meta.url), 'utf8');
  assert.match(dashboardApi, /new TransactWriteCommand\(\{\s*TransactItems: \[\s*\{ Put: \{ TableName, Item: template/);
  assert.match(dashboardApi, /PK: key\.project\(projectId\), SK: key\.templateCurrent\(body\.slug\)/);
  assert.match(dashboardApi, /ConditionExpression: 'attribute_not_exists\(PK\)'/);
});

test('dashboard uses the persisted template endpoint and does not fall back to mocks on failure', async () => {
  const app = await fs.readFile(new URL('../../apps/dashboard/app.js', import.meta.url), 'utf8');
  assert.match(app, /adminRequest\(`\/v1\/projects\/\$\{encodeURIComponent\(projectId\)\}\/templates`\)/);
  assert.match(app, /sessionTemplates = \[\];\s+templateLoadError = friendlyError\(err\)/);
  assert.match(app, /case 'templates':\s+loadTemplates\(\)/);
  assert.match(app, /templates-refresh-btn.*loadTemplates/s);
});

test('campaign lookup trims the slug and validates the current version as published', async () => {
  const campaignApi = await fs.readFile(new URL('../../apps/api/src/campaign-api.js', import.meta.url), 'utf8');
  const store = await fs.readFile(new URL('../../apps/api/src/store.js', import.meta.url), 'utf8');
  assert.match(campaignApi, /const templateSlug = body\.template\.trim\(\)/);
  assert.match(campaignApi, /getTemplate\(apiKey\.projectId, templateSlug\)/);
  assert.match(campaignApi, /template\.state !== 'published'/);
  assert.match(store, /templateCurrent: \(slug\) => `TEMPLATE#\$\{slug\}#CURRENT`/);
});

test('template management uses project-authorized versioned update and pointer deletion routes', async () => {
  const dashboardApi = await fs.readFile(new URL('../../apps/api/src/dashboard-api.js', import.meta.url), 'utf8');
  const template = await fs.readFile(new URL('../../apps/dashboard/app.js', import.meta.url), 'utf8');
  const infra = await fs.readFile(new URL('../../infra/template.yaml', import.meta.url), 'utf8');
  assert.match(dashboardApi, /method === 'PUT' \|\| method === 'DELETE'/);
  assert.match(dashboardApi, /TEMPLATE_VERSION_CONFLICT/);
  assert.match(dashboardApi, /key\.template\(templateSlug, version\)/);
  assert.match(dashboardApi, /key\.templateCurrent\(templateSlug\)/);
  assert.match(dashboardApi, /method === 'DELETE'/);
  assert.match(infra, /Path: "\/v1\/projects\/\{projectId\}\/templates\/\{templateSlug\}"[\s\S]*Method: PUT/);
  assert.match(infra, /Path: "\/v1\/projects\/\{projectId\}\/templates\/\{templateSlug\}"[\s\S]*Method: DELETE/);
  assert.match(template, /data-template-action="view"/);
  assert.match(template, /data-template-action="edit"/);
  assert.match(template, /data-template-action="delete"/);
  assert.match(template, /adminRequest\(path, editingTemplate \? 'PUT' : 'POST'/);
  assert.match(template, /Demo templates are read-only/);
  assert.match(template, /sessionTemplates = \[\];\s+templateLoadError = friendlyError\(err\)/);
});
