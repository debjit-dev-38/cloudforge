// DynamoDB persistence boundary for the Lambda application.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  TransactWriteCommand,
  QueryCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { createHash, randomUUID } from 'node:crypto';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TABLE_NAME;
const now = () => new Date().toISOString();

export const key = {
  project: (id) => `PROJECT#${id}`,
  apiKey: (hash) => `APIKEY#${hash}`,
  recipient: (email) => `RECIPIENT#${email}`,
  notification: (id) => `NOTIFICATION#${id}`,
  idempotency: (id) => `IDEMPOTENCY#${id}`,
  template: (slug, version) => `TEMPLATE#${slug}#V${version}`,
  templateCurrent: (slug) => `TEMPLATE#${slug}#CURRENT`,
  user: (id) => `USER#${id}`,
  device: (recipient, token) => `DEVICE#${recipient}#${createHash('sha256').update(token).digest('hex')}`,
  campaign: (id) => `CAMPAIGN#${id}`,
  campaignRecipient: (campaignId, recipient) => `CAMPAIGN#${campaignId}#RECIPIENT#${createHash('sha256').update(recipient).digest('hex')}`,
};

export async function get(pk, sk) {
  const result = await client.send(new GetCommand({ TableName, Key: { PK: pk, SK: sk } }));
  return result.Item;
}

export async function getApiKey(hash) {
  return get(key.apiKey(hash), 'META');
}

export async function getProjectMembership(userId, organizationId) {
  return get(key.user(userId), `MEMBERSHIP#${organizationId}`);
}

export async function getTemplate(projectId, slug) {
  const current = await get(key.project(projectId), key.templateCurrent(slug));
  return current ? get(key.project(projectId), key.template(slug, current.version)) : undefined;
}

export async function getTemplateVersion(projectId, slug, version) {
  return get(key.project(projectId), key.template(slug, version));
}

export async function getRecipient(projectId, email) {
  return get(key.project(projectId), key.recipient(email));
}

export async function registerDevice({ projectId, organizationId, recipient, token, platform }) {
  const createdAt = now();
  await client.send(new PutCommand({
    TableName,
    Item: { PK: key.project(projectId), SK: key.device(recipient, token), projectId, organizationId, recipient, token, platform, status: 'active', createdAt, updatedAt: createdAt },
    ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
  }));
}

export async function removeDevice(projectId, recipient, token) {
  await client.send(new DeleteCommand({ TableName, Key: { PK: key.project(projectId), SK: key.device(recipient, token) } }));
}

export async function listDevices(projectId, recipient) {
  const result = await client.send(new QueryCommand({
    TableName, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': key.project(projectId), ':prefix': `DEVICE#${recipient}#` },
  }));
  return result.Items || [];
}

export async function disableDevice(projectId, recipient, token, reason = 'invalid_token') {
  await client.send(new UpdateCommand({
    TableName, Key: { PK: key.project(projectId), SK: key.device(recipient, token) },
    UpdateExpression: 'SET #status = :status, disableReason = :reason, updatedAt = :updatedAt',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':status': 'disabled', ':reason': reason, ':updatedAt': now() },
  }));
}

export async function createNotification({ projectId, organizationId, idempotencyKey, notification }) {
  const items = [{
    Put: {
      TableName,
      Item: notification,
      ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
    },
  }];
  if (idempotencyKey) {
    items.push({
      Put: {
        TableName,
        Item: {
          PK: key.project(projectId), SK: key.idempotency(idempotencyKey), organizationId, projectId,
          notificationId: notification.notificationId, createdAt: now(), expiresAt: Math.floor(Date.now() / 1000) + 86_400,
        },
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      },
    });
  }
  await client.send(new TransactWriteCommand({ TableName, TransactItems: items }));
}

export async function createCampaign({ campaign, recipients }) {
  const chunks = [];
  for (let index = 0; index < recipients.length; index += 90) chunks.push(recipients.slice(index, index + 90));
  await client.send(new TransactWriteCommand({ TableName, TransactItems: [{ Put: { TableName, Item: campaign, ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)' } }] }));
  for (const chunk of chunks) {
    await client.send(new TransactWriteCommand({ TableName, TransactItems: chunk.map((recipient) => ({ Put: { TableName, Item: { PK: key.project(campaign.projectId), SK: key.campaignRecipient(campaign.campaignId, recipient), campaignId: campaign.campaignId, projectId: campaign.projectId, recipient, status: 'pending' }, ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)' } })) }));
  }
}

export async function getCampaign(projectId, campaignId) {
  return get(key.project(projectId), key.campaign(campaignId));
}

export async function listCampaigns(projectId, limit = 50) {
  return client.send(new QueryCommand({ TableName, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)', ExpressionAttributeValues: { ':pk': key.project(projectId), ':prefix': 'CAMPAIGN#' }, ScanIndexForward: false, Limit: Math.min(Math.max(limit, 1), 100) }));
}

export async function claimCampaignRecipient(projectId, campaignId, recipient, leaseCutoff = new Date(Date.now() - 300000).toISOString()) {
  const claimToken = randomUUID();
  try {
    const result = await client.send(new UpdateCommand({ TableName, Key: { PK: key.project(projectId), SK: key.campaignRecipient(campaignId, recipient) }, UpdateExpression: 'SET #status = :processing, claimedAt = :claimedAt, claimToken = :claimToken', ConditionExpression: '#status = :pending OR (#status = :processing AND claimedAt < :leaseCutoff)', ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':pending': 'pending', ':processing': 'processing', ':claimedAt': now(), ':claimToken': claimToken, ':leaseCutoff': leaseCutoff }, ReturnValues: 'ALL_NEW' }));
    return result.Attributes;
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') return null;
    throw error;
  }
}

export async function listPendingCampaignRecipients(projectId, campaignId, limit = 25, leaseCutoff = new Date(Date.now() - 300000).toISOString()) {
  const result = await client.send(new QueryCommand({ TableName, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)', FilterExpression: '#status = :pending OR (#status = :processing AND claimedAt < :leaseCutoff)', ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':pk': key.project(projectId), ':prefix': `CAMPAIGN#${campaignId}#RECIPIENT#`, ':pending': 'pending', ':processing': 'processing', ':leaseCutoff': leaseCutoff }, Limit: Math.min(limit, 25) }));
  return result.Items || [];
}

export async function completeCampaignRecipient({ projectId, campaignId, recipient, status, error, claimToken }) {
  const success = status === 'succeeded';
  await client.send(new TransactWriteCommand({ TableName, TransactItems: [
    { Update: { TableName, Key: { PK: key.project(projectId), SK: key.campaignRecipient(campaignId, recipient) }, UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt, failureReason = :error', ConditionExpression: '#status = :processing AND claimToken = :claimToken', ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':processing': 'processing', ':status': status, ':updatedAt': now(), ':error': error || null, ':claimToken': claimToken } } },
    { Update: { TableName, Key: { PK: key.project(projectId), SK: key.campaign(campaignId) }, UpdateExpression: 'SET processed = if_not_exists(processed, :zero) + :one, successful = if_not_exists(successful, :zero) + :success, failed = if_not_exists(failed, :zero) + :failure, pending = if_not_exists(pending, :zero) - :one, updatedAt = :updatedAt', ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':success': success ? 1 : 0, ':failure': success ? 0 : 1, ':updatedAt': now() } } },
  ] }));
}

export async function releaseCampaignRecipient(projectId, campaignId, recipient, claimToken) {
  await client.send(new UpdateCommand({ TableName, Key: { PK: key.project(projectId), SK: key.campaignRecipient(campaignId, recipient) }, UpdateExpression: 'SET #status = :pending, updatedAt = :updatedAt', ConditionExpression: '#status = :processing AND claimToken = :claimToken', ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':processing': 'processing', ':pending': 'pending', ':updatedAt': now(), ':claimToken': claimToken } }));
}

export async function updateCampaignState(projectId, campaignId, from, to) {
  await client.send(new UpdateCommand({ TableName, Key: { PK: key.project(projectId), SK: key.campaign(campaignId) }, UpdateExpression: 'SET #state = :to, updatedAt = :updatedAt', ConditionExpression: '#state = :from', ExpressionAttributeNames: { '#state': 'state' }, ExpressionAttributeValues: { ':from': from, ':to': to, ':updatedAt': now() } }));
}

export async function getIdempotency(projectId, idempotencyKey) {
  return get(key.project(projectId), key.idempotency(idempotencyKey));
}

export async function consumeRateLimit(projectId, limit = 60) {
  const minute = Math.floor(Date.now() / 60_000);
  try {
    await client.send(new UpdateCommand({
      TableName, Key: { PK: key.project(projectId), SK: `RATE#${minute}` },
      UpdateExpression: 'SET #count = if_not_exists(#count, :zero) + :one, expiresAt = :expiresAt',
      ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
      ExpressionAttributeNames: { '#count': 'count' },
      ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':limit': limit, ':expiresAt': minute * 60 + 120 },
    }));
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      const rateError = new Error('Project rate limit exceeded');
      rateError.code = 'RATE_LIMITED';
      throw rateError;
    }
    throw error;
  }
}

export async function updateStatus(projectId, notificationId, currentStatus, status, patch = {}) {
  const expressionNames = { '#status': 'status' };
  const expressionValues = { ':current': currentStatus, ':next': status, ':updatedAt': now() };
  const set = ['#status = :next', 'updatedAt = :updatedAt'];
  for (const [name, value] of Object.entries(patch)) {
    expressionNames[`#${name}`] = name;
    expressionValues[`:${name}`] = value;
    set.push(`#${name} = :${name}`);
  }
  await client.send(new UpdateCommand({
    TableName, Key: { PK: key.project(projectId), SK: key.notification(notificationId) },
    UpdateExpression: `SET ${set.join(', ')}`,
    ConditionExpression: '#status = :current', ExpressionAttributeNames: expressionNames,
    ExpressionAttributeValues: expressionValues,
  }));
}

export async function setRecipientStatus(projectId, email, status, reason) {
  await client.send(new PutCommand({
    TableName,
    Item: { PK: key.project(projectId), SK: key.recipient(email), projectId, email, status, reason, updatedAt: now() },
  }));
}

export async function listNotifications(projectId, limit = 50, exclusiveStartKey) {
  return client.send(new QueryCommand({
    TableName, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': key.project(projectId), ':prefix': 'NOTIFICATION#' },
    ExclusiveStartKey: exclusiveStartKey,
    ScanIndexForward: false, Limit: Math.min(Math.max(limit, 1), 100),
  }));
}

export async function revokeApiKey(hash) {
  await client.send(new UpdateCommand({
    TableName, Key: { PK: key.apiKey(hash), SK: 'META' },
    UpdateExpression: 'SET revokedAt = :revokedAt',
    ExpressionAttributeValues: { ':revokedAt': now() },
  }));
}
