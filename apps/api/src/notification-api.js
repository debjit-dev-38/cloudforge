// Public notification API Lambda handler.
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { apiKeyHash, errorResponse, json, newId, parseJson, renderTemplate, requestId } from './core.js';
import { consumeRateLimit, createNotification, getApiKey, getIdempotency, getRecipient, getTemplate, key } from './store.js';
import { normalizeChannelAndRecipient, normalizePushContent, queueMessage } from './delivery.js';

const sqs = new SQSClient({});
const QueueUrl = process.env.QUEUE_URL;

function header(event, name) {
  return event.headers?.[name] || event.headers?.[name.toLowerCase()];
}

export async function handler(event) {
  const correlationId = requestId(event);
  const respond = (statusCode, body) => json(statusCode, body, correlationId);
  try {
    const rawKey = header(event, 'x-api-key');
    if (!rawKey) return respond(401, { error: 'x-api-key is required', code: 'API_KEY_REQUIRED' });
    const apiKey = await getApiKey(apiKeyHash(rawKey, process.env.API_KEY_PEPPER));
    if (!apiKey || apiKey.revokedAt) return respond(401, { error: 'Invalid API key', code: 'INVALID_API_KEY' });

    const body = parseJson(event.body);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return respond(400, { error: 'Request body must be an object', code: 'INVALID_REQUEST' });
    if (typeof body.template !== 'string') return respond(400, { error: 'template is required', code: 'INVALID_REQUEST' });
    const { channel, recipient } = normalizeChannelAndRecipient(body);
    const push = channel === 'push' ? normalizePushContent(body.push) : undefined;
    const idempotencyKey = body.idempotencyKey || header(event, 'idempotency-key');
    if (idempotencyKey && (typeof idempotencyKey !== 'string' || idempotencyKey.length > 128)) {
      return respond(400, { error: 'idempotencyKey must be at most 128 characters', code: 'INVALID_REQUEST' });
    }
    if (idempotencyKey) {
      const prior = await getIdempotency(apiKey.projectId, idempotencyKey);
      if (prior) {
        await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: queueMessage(apiKey.projectId, prior.notificationId) }));
        return respond(202, { notificationId: prior.notificationId, idempotent: true });
      }
    }
    const [template, recipientStatus] = await Promise.all([
      getTemplate(apiKey.projectId, body.template),
      getRecipient(apiKey.projectId, recipient),
    ]);
    if (!template || template.state !== 'published') return respond(404, { error: 'Published template not found', code: 'TEMPLATE_NOT_FOUND' });
    if (recipientStatus?.status === 'suppressed' || recipientStatus?.status === 'opted_out') {
      return respond(409, { error: 'Recipient is suppressed', code: 'RECIPIENT_SUPPRESSED' });
    }
    if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) return respond(400, { error: 'data must be an object', code: 'INVALID_REQUEST' });
    renderTemplate(template.subject, body.data);
    renderTemplate(template.html, body.data);
    if (template.text) renderTemplate(template.text, body.data);
    await consumeRateLimit(apiKey.projectId, apiKey.maxPerMinute || 60);

    const notificationId = newId('ntf');
    const createdAt = new Date().toISOString();
    const notification = {
      PK: key.project(apiKey.projectId), SK: key.notification(notificationId), notificationId,
      organizationId: apiKey.organizationId, projectId: apiKey.projectId, templateSlug: template.slug,
      templateVersion: template.version, channel, recipient, ...(push ? { push } : {}), data: body.data, metadata: body.metadata || {},
      status: 'queued', createdAt, updatedAt: createdAt,
    };
    try {
      await createNotification({ organizationId: apiKey.organizationId, projectId: apiKey.projectId, idempotencyKey, notification });
    } catch (error) {
      if (idempotencyKey && error.name === 'TransactionCanceledException') {
        const prior = await getIdempotency(apiKey.projectId, idempotencyKey);
        if (prior) {
          await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: queueMessage(apiKey.projectId, prior.notificationId) }));
          return respond(202, { notificationId: prior.notificationId, idempotent: true });
        }
      }
      throw error;
    }
    await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: queueMessage(apiKey.projectId, notificationId, channel) }));
    console.log(JSON.stringify({ event: 'notification_queued', requestId: correlationId, organizationId: apiKey.organizationId, projectId: apiKey.projectId, notificationId }));
    return respond(202, { notificationId, status: 'queued' });
  } catch (error) {
    console.error(JSON.stringify({ event: 'notification_api_error', requestId: correlationId, error: error.message, errorName: error.name }));
    return errorResponse(error, correlationId);
  }
}
