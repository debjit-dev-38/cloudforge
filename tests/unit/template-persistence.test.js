import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { ensureDefaultTemplates, getTemplate, listTemplates, setStoreClientForTests } from '../../apps/api/src/store.js';

function fakeTemplateClient(items) {
  const byKey = new Map(items.map((item) => [`${item.PK}|${item.SK}`, item]));
  return {
    calls: [],
    async send(command) {
      this.calls.push(command.input);
      if (command.input.TransactItems) return {};
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

test('default templates seed idempotently without overwriting an existing custom slug', async () => {
  const items = new Map();
  const client = { calls: [], async send(command) {
    this.calls.push(command.input);
    if (command.input.Key) return { Item: items.get(`${command.input.Key.PK}|${command.input.Key.SK}`) };
    for (const operation of command.input.TransactItems || []) {
      const write = operation.Put;
      if (write) items.set(`${write.Item.PK}|${write.Item.SK}`, write.Item);
    }
    return {};
  } };
  items.set('PROJECT#p1|TEMPLATE#otp-verification#CURRENT', { version: 4, state: 'draft' });
  const restore = setStoreClientForTests(client);
  try {
    await ensureDefaultTemplates('p1');
    await ensureDefaultTemplates('p1');
    assert.equal([...items.keys()].filter(keyName => keyName.includes('TEMPLATE#')).length, 5);
    assert.equal(items.get('PROJECT#p1|TEMPLATE#otp-verification#CURRENT').version, 4);
    assert.equal(items.get('PROJECT#p1|TEMPLATE#welcome-onboarding#CURRENT').state, 'published');
  } finally { restore(); }
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
  for (const slug of ['welcome-onboarding', 'otp-verification', 'invoice-receipt']) assert.match(app, new RegExp(`slug: '${slug}'`));
  assert.match(app, /if \(isDemoMode\) \{[\s\S]*sessionTemplates = \[\.\.\.MOCK_DATA\.templates\]/);
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
  assert.match(template, /adminRequest\(path, isEdit \? 'PUT' : 'POST'/);
  assert.match(template, /Demo templates are read-only/);
  assert.match(template, /sessionTemplates = \[\];\s+templateLoadError = friendlyError\(err\)/);
  assert.match(template, /method, url, cause: err/);
  assert.match(template, /err\?\.status === 409/);
});

test('new and edit template flows use explicit modes and separate HTTP operations', async () => {
  const app = await fs.readFile(new URL('../../apps/dashboard/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../../apps/dashboard/index.html', import.meta.url), 'utf8');
  assert.match(app, /let templateMode = 'create'/);
  assert.match(app, /template-create-btn'\)\.addEventListener\('click', \(\) => openTemplateModal\(\)\)/);
  assert.match(app, /templateMode = template \? 'edit' : 'create'/);
  assert.match(app, /const isEdit = templateMode === 'edit'/);
  assert.match(app, /adminRequest\(path, isEdit \? 'PUT' : 'POST'/);
  assert.match(app, /editingTemplate = templateMode === 'edit' \? template : null/);
  assert.match(app, /templateMode = 'create';\s+editingTemplate = null/);
  assert.doesNotMatch(app, /addEventListener\('click', openTemplateModal\)/);
  assert.match(html, /id="template-modal-title">Create Template/);
});

test('template deletion has the required least-privilege permission and preserves safeguards', async () => {
  const infra = await fs.readFile(new URL('../../infra/template.yaml', import.meta.url), 'utf8');
  const dashboardApi = await fs.readFile(new URL('../../apps/api/src/dashboard-api.js', import.meta.url), 'utf8');
  const app = await fs.readFile(new URL('../../apps/dashboard/app.js', import.meta.url), 'utf8');
  assert.match(infra, /DashboardFunction:[\s\S]*?dynamodb:DeleteItem[\s\S]*?Resource: !GetAtt NotificationTable\.Arn/);
  assert.match(dashboardApi, /if \(!current\) return respond\(404, \{ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' \}\)/);
  assert.match(dashboardApi, /key\.templateCurrent\(templateSlug\)/);
  assert.match(dashboardApi, /ConditionExpression: 'attribute_exists\(PK\)'/);
  assert.match(app, /await adminRequest\(`\/v1\/projects\/\$\{encodeURIComponent\(storedProjectId\(\)\)\}\/templates\/\$\{encodeURIComponent\(template\.slug\)\}`, 'DELETE'\)/);
  assert.match(app, /await loadTemplates\(\);\s+toast\(`Template/);
});

test('template deletion cleans all versions and reports create conflicts clearly', async () => {
  const store = await fs.readFile(new URL('../../apps/api/src/store.js', import.meta.url), 'utf8');
  const api = await fs.readFile(new URL('../../apps/api/src/dashboard-api.js', import.meta.url), 'utf8');
  const app = await fs.readFile(new URL('../../apps/dashboard/app.js', import.meta.url), 'utf8');
  assert.match(store, /export async function listTemplateVersions/);
  assert.match(api, /const versions = await listTemplateVersions\(projectId, templateSlug\)/);
  assert.match(api, /const deletes = versions\.map\(\(version\) => \(\{ Delete:/);
  assert.match(api, /TEMPLATE_SLUG_EXISTS/);
  assert.match(api, /A template with this slug already exists/);
  assert.match(app, /TEMPLATE_SLUG_EXISTS/);
});

test('overview campaign metrics use the selected project key and fail visibly on invalid data', async () => {
  const app = await fs.readFile(new URL('../../apps/dashboard/app.js', import.meta.url), 'utf8');
  assert.match(app, /const apiKeyProjectId = storedApiKeyProjectId\(\)/);
  assert.match(app, /apiKeyProjectId && apiKeyProjectId !== projectId/);
  assert.match(app, /The campaign list response was invalid/);
  assert.match(app, /c\.projectId === projectId/);
  assert.match(app, /ACTIVE_CAMPAIGN_STATES = new Set\(\['scheduled', 'queued', 'running', 'paused'\]\)/);
});

test('overview exposes total and completed campaign metrics without changing active status rules', async () => {
  const app = await fs.readFile(new URL('../../apps/dashboard/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../../apps/dashboard/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="stat-total-campaigns"/);
  assert.match(html, /Recently Completed Campaigns/);
  assert.match(app, /const completed = campaigns\.filter\(c => c\.state === 'completed'\)/);
  assert.match(app, /Number\(c\.successful\)/);
  assert.match(app, /Number\(c\.failed\)/);
  assert.match(app, /active = campaigns\.filter\(isActiveCampaign\)/);
  assert.match(app, /campaign\.state === 'scheduled' && campaign\.scheduledAt/);
});

test('authorized project listing is Cognito-scoped and dashboard selection rejects stale projects', async () => {
  const api = await fs.readFile(new URL('../../apps/api/src/dashboard-api.js', import.meta.url), 'utf8');
  const store = await fs.readFile(new URL('../../apps/api/src/store.js', import.meta.url), 'utf8');
  const infra = await fs.readFile(new URL('../../infra/template.yaml', import.meta.url), 'utf8');
  const app = await fs.readFile(new URL('../../apps/dashboard/app.js', import.meta.url), 'utf8');
  assert.match(api, /method === 'GET' && path === '\/v1\/projects'/);
  assert.match(api, /listAuthorizedProjects\(userId\(event\)/);
  assert.match(store, /begins_with\(SK, :prefix\)/);
  assert.match(store, /IndexName: 'OrganizationProjectsIndex'/);
  assert.match(store, /FilterExpression: 'SK = :meta'/);
  assert.match(infra, /OrganizationProjectsIndex/);
  assert.match(infra, /DashboardFunction:[\s\S]*?OrganizationProjectsIndex[\s\S]*?dynamodb:Query/);
  assert.match(infra, /Path: \/v1\/projects\/\{projectId\}[\s\S]*?Method: DELETE/);
  assert.match(api, /deleteProjectData\(projectId\)/);
  assert.match(app, /Delete Selected Project/);
  assert.match(app, /adminRequest\('\/v1\/projects'\)/);
  assert.match(app, /authorizedProjects\.some\(\(project\) => project\.projectId === saved\)/);
  assert.match(app, /sessionTemplates = \[\];\s+campaignsData = \[\];\s+ntfAllItems = \[\]/);
});
