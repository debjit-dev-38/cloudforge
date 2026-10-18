// Authenticated dashboard API Lambda handler.
import { DeleteCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { apiKeyHash, decodeCursor, encodeCursor, errorResponse, json, newId, parseJson, requestId, templateVariables } from './core.js';
import { ensureDefaultTemplates, get, getProjectMembership, getTemplate, key, listAuthorizedProjects, listNotifications, listTemplateVersions, listTemplates, revokeApiKey } from './store.js';

let client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TABLE_NAME;
const userId = (event) => event.requestContext?.authorizer?.jwt?.claims?.sub;

export function setDashboardClientForTests(nextClient) {
  const previous = client;
  client = nextClient;
  return () => { client = previous; };
}

async function authorizedProject(event, projectId) {
  const project = await get(key.project(projectId), 'META');
  if (!project) return undefined;
  if (project.ownerUserId === userId(event)) return project;
  const membership = await getProjectMembership(userId(event), project.organizationId);
  return membership ? project : undefined;
}

export async function handler(event) {
  const correlationId = requestId(event);
  const respond = (statusCode, body) => json(statusCode, body, correlationId);
  try {
    const method = event.requestContext.http.method;
    const path = event.rawPath;
    const projectId = event.pathParameters?.projectId;
    if (method === 'GET' && path === '/v1/dashboard-config') {
      return respond(200, {
        cognitoClientId: process.env.COGNITO_CLIENT_ID,
        cognitoUserPoolId: process.env.COGNITO_USER_POOL_ID,
        cognitoDomain: process.env.COGNITO_DOMAIN,
      });
    }
    if (!userId(event)) return respond(401, { error: 'Authentication required', code: 'AUTHENTICATION_REQUIRED' });

    if (method === 'POST' && path === '/v1/projects') {
      const body = parseJson(event.body);
      if (!body || typeof body.name !== 'string' || !body.name.trim()) return respond(400, { error: 'name is required', code: 'INVALID_REQUEST' });
      const id = newId('prj');
      const organizationId = newId('org');
      const createdAt = new Date().toISOString();
      await client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName,
              Item: { PK: key.project(id), SK: 'META', projectId: id, organizationId, name: body.name.trim(), ownerUserId: userId(event), createdAt },
              ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
            },
          },
          {
            Put: {
              TableName,
              Item: { PK: key.user(userId(event)), SK: `MEMBERSHIP#${organizationId}`, userId: userId(event), organizationId, projectId: id, role: 'owner', createdAt },
              ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
            },
          },
        ],
      }));
      await ensureDefaultTemplates(id);
      return respond(201, { projectId: id, organizationId });
    }
    if (method === 'GET' && path === '/v1/projects') {
      const limitValue = event.queryStringParameters?.limit;
      const limit = limitValue === undefined ? 50 : Number(limitValue);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return respond(400, { error: 'limit must be an integer between 1 and 100', code: 'INVALID_REQUEST' });
      const projects = await listAuthorizedProjects(userId(event), limit, decodeCursor(event.queryStringParameters?.cursor));
      const body = { projects: projects.projects };
      if (projects.LastEvaluatedKey) body.nextCursor = encodeCursor(projects.LastEvaluatedKey);
      return respond(200, body);
    }
    if (!projectId || !(await authorizedProject(event, projectId))) return respond(404, { error: 'Project not found', code: 'PROJECT_NOT_FOUND' });

    if (method === 'DELETE' && path === `/v1/projects/${projectId}`) {
      const project = await get(key.project(projectId), 'META');
      if (!project) return respond(404, { error: 'Project not found', code: 'PROJECT_NOT_FOUND' });
      let ExclusiveStartKey;
      do {
        const result = await client.send(new QueryCommand({
          TableName,
          KeyConditionExpression: 'PK = :pk',
          FilterExpression: 'SK <> :meta',
          ExpressionAttributeValues: { ':pk': key.project(projectId), ':meta': 'META' },
          ProjectionExpression: 'SK',
          Limit: 25,
          ExclusiveStartKey,
        }));
        if ((result.Items || []).length) return respond(409, { error: 'Project has dependent resources and cannot be deleted.', code: 'PROJECT_HAS_DEPENDENCIES' });
        ExclusiveStartKey = result.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      await client.send(new DeleteCommand({
        TableName,
        Key: { PK: key.project(projectId), SK: 'META' },
        ConditionExpression: 'attribute_exists(PK) AND organizationId = :organizationId',
        ExpressionAttributeValues: { ':organizationId': project.organizationId },
      }));
      return respond(200, { projectId, deleted: true });
    }

    if (method === 'POST' && path.endsWith('/api-keys')) {
      const body = parseJson(event.body);
      const raw = `nfy_${newId('key').replaceAll('-', '')}`;
      const keyId = newId('key');
      const hash = apiKeyHash(raw, process.env.API_KEY_PEPPER);
      const project = await get(key.project(projectId), 'META');
      const item = { hash, keyId, projectId, organizationId: project.organizationId, label: body?.label || 'default', createdAt: new Date().toISOString(), maxPerMinute: 60 };
      await client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName,
              Item: { PK: key.apiKey(hash), SK: 'META', ...item },
              ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
            },
          },
          {
            Put: {
              TableName,
              Item: { PK: key.project(projectId), SK: `APIKEY#${keyId}`, ...item },
              ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
            },
          },
        ],
      }));
      return respond(201, { keyId, apiKey: raw, warning: 'Copy this value now; it cannot be retrieved again.' });
    }
    if (method === 'DELETE' && path.includes('/api-keys/')) {
      const keyId = event.pathParameters?.apiKeyId;
      const apiKey = await get(key.project(projectId), `APIKEY#${keyId}`);
      if (!apiKey) return respond(404, { error: 'API key not found', code: 'API_KEY_NOT_FOUND' });
      await revokeApiKey(apiKey.hash);
      return respond(200, { keyId, revoked: true });
    }
    const templateSlug = event.pathParameters?.templateSlug;
    if ((method === 'PUT' || method === 'DELETE') && path.includes('/templates/')) {
      if (!/^[a-z0-9-]+$/.test(templateSlug || '')) return respond(400, { error: 'invalid template slug', code: 'INVALID_REQUEST' });
      const current = await getTemplate(projectId, templateSlug);

      if (method === 'DELETE') {
        const versions = await listTemplateVersions(projectId, templateSlug);
        const pointer = await get(key.project(projectId), key.templateCurrent(templateSlug));
        if (!current && !pointer && versions.length === 0) return respond(404, { error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        if (versions.length + 1 > 100) return respond(409, { error: 'Template has too many versions to delete in one operation', code: 'TEMPLATE_TOO_MANY_VERSIONS' });
        const deletes = versions.map((version) => ({ Delete: { TableName, Key: { PK: version.PK, SK: version.SK } } }));
        if (pointer) deletes.push({ Delete: { TableName, Key: { PK: key.project(projectId), SK: key.templateCurrent(templateSlug) }, ConditionExpression: 'attribute_exists(PK)' } });
        await client.send(new TransactWriteCommand({
          TransactItems: deletes,
        }));
        return respond(200, { slug: templateSlug, deleted: true });
      }

      if (!current) return respond(404, { error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });

      const body = parseJson(event.body);
      if (!Number.isInteger(body?.expectedVersion) || body.expectedVersion !== current.version) return respond(409, { error: 'Template changed; reload before editing', code: 'TEMPLATE_VERSION_CONFLICT' });
      if (![body?.subject, body?.html].every((value) => typeof value === 'string')) return respond(400, { error: 'subject and html are required', code: 'INVALID_REQUEST' });
      if (body.state !== undefined && body.state !== 'published' && body.state !== 'draft') return respond(400, { error: 'state must be published or draft', code: 'INVALID_REQUEST' });
      if (body.text !== undefined && typeof body.text !== 'string') return respond(400, { error: 'text must be a string', code: 'INVALID_REQUEST' });
      const version = current.version + 1;
      const text = body.text === undefined ? (current.text || '') : body.text;
      const state = body.state === undefined ? current.state : body.state;
      const updatedAt = new Date().toISOString();
      const template = { PK: key.project(projectId), SK: key.template(templateSlug, version), projectId, slug: templateSlug, version, state, subject: body.subject, html: body.html, text, variables: [...new Set([...templateVariables(body.subject), ...templateVariables(body.html), ...templateVariables(text)])], createdAt: updatedAt };
      await client.send(new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName, Item: template, ConditionExpression: 'attribute_not_exists(PK)' } },
          { Update: { TableName, Key: { PK: key.project(projectId), SK: key.templateCurrent(templateSlug) }, UpdateExpression: 'SET #version = :version, #state = :state, updatedAt = :updatedAt', ConditionExpression: '#version = :expectedVersion', ExpressionAttributeNames: { '#version': 'version', '#state': 'state' }, ExpressionAttributeValues: { ':version': version, ':state': state, ':updatedAt': updatedAt, ':expectedVersion': current.version } } },
        ],
      }));
      return respond(200, { template });
    }
    if (method === 'POST' && path.endsWith('/templates')) {
      const body = parseJson(event.body);
      if (!/^[a-z0-9-]+$/.test(body?.slug || '')) return respond(400, { error: 'slug must contain lowercase letters, digits, and hyphens', code: 'INVALID_REQUEST' });
      if (![body.subject, body.html].every((value) => typeof value === 'string')) return respond(400, { error: 'subject and html are required', code: 'INVALID_REQUEST' });
      const version = 1;
      const template = { PK: key.project(projectId), SK: key.template(body.slug, version), projectId, slug: body.slug, version, state: body.state === 'published' ? 'published' : 'draft', subject: body.subject, html: body.html, text: body.text || '', variables: [...new Set([...templateVariables(body.subject), ...templateVariables(body.html), ...templateVariables(body.text || '')])], createdAt: new Date().toISOString() };
      try {
        await client.send(new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName, Item: template, ConditionExpression: 'attribute_not_exists(PK)' } },
            { Put: { TableName, Item: { PK: key.project(projectId), SK: key.templateCurrent(body.slug), version, state: template.state }, ConditionExpression: 'attribute_not_exists(PK)' } },
          ],
        }));
      } catch (error) {
        if (error?.name === 'ConditionalCheckFailedException' || error?.name === 'TransactionCanceledException') return respond(409, { error: 'A template with this slug already exists. Choose a different slug or edit the existing template.', code: 'TEMPLATE_SLUG_EXISTS' });
        throw error;
      }
      return respond(201, { template });
    }
    if (method === 'GET' && path.endsWith('/templates')) {
      const templates = await listTemplates(projectId);
      return respond(200, { templates });
    }
    if (method === 'GET' && path.endsWith('/notifications')) {
      const limitValue = event.queryStringParameters?.limit;
      const limit = limitValue === undefined ? 50 : Number(limitValue);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return respond(400, { error: 'limit must be an integer between 1 and 100', code: 'INVALID_REQUEST' });
      const cursor = decodeCursor(event.queryStringParameters?.cursor);
      const result = await listNotifications(projectId, limit, cursor);
      const body = { notifications: result.Items || [] };
      if (result.LastEvaluatedKey) body.nextCursor = encodeCursor(result.LastEvaluatedKey);
      return respond(200, body);
    }
    return respond(404, { error: 'Route not found', code: 'NOT_FOUND' });
  } catch (error) {
    console.error(JSON.stringify({ event: 'dashboard_api_error', requestId: correlationId, error: error.message, errorName: error.name }));
    return errorResponse(error, correlationId);
  }
}
