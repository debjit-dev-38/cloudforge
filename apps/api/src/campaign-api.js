import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { CreateScheduleCommand, SchedulerClient } from '@aws-sdk/client-scheduler';
import { ApiError, apiKeyHash, errorResponse, json, newId, parseJson, renderTemplate, requestId } from './core.js';
import { campaignQueueMessage, deliveryChannels, normalizeCampaignRecipients, normalizePushContent } from './delivery.js';
import { consumeRateLimit, createCampaign, getApiKey, getCampaign, getRecipient, getTemplate, key, listCampaigns, updateCampaignState } from './store.js';

const sqs = new SQSClient({});
const scheduler = new SchedulerClient({});
const QueueUrl = process.env.QUEUE_URL;
const SchedulerRoleArn = process.env.SCHEDULER_ROLE_ARN;
const StartFunctionArn = process.env.START_CAMPAIGN_FUNCTION_ARN;
const startDependencies = { getCampaign, updateCampaignState, sqs };

export function setCampaignStartDependenciesForTests(overrides) {
  const previous = { ...startDependencies };
  Object.assign(startDependencies, overrides);
  return () => Object.assign(startDependencies, previous);
}

function header(event, name) { return event.headers?.[name] || event.headers?.[name.toLowerCase()]; }

export function validateScheduledAt(value) {
  if (typeof value !== 'string' || !value.trim()) throw new ApiError(400, 'INVALID_SCHEDULE', 'scheduledAt must be an ISO 8601 timestamp');
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) throw new ApiError(400, 'INVALID_SCHEDULE', 'scheduledAt must include an explicit timezone');
  if (timestamp <= Date.now()) throw new ApiError(400, 'INVALID_SCHEDULE', 'scheduledAt must be in the future');
  return new Date(timestamp).toISOString();
}

function scheduleName(projectId, campaignId) {
  return `campaign-${projectId}-${campaignId}`.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64);
}

async function createCampaignSchedule({ projectId, campaignId, scheduledAt }) {
  if (!SchedulerRoleArn || !StartFunctionArn) throw new Error('Campaign scheduler is not configured');
  const at = scheduledAt.replace(/\.\d{3}Z$/, 'Z').replace('Z', '');
  await scheduler.send(new CreateScheduleCommand({
    Name: scheduleName(projectId, campaignId),
    ScheduleExpression: `at(${at})`,
    FlexibleTimeWindow: { Mode: 'OFF' },
    ActionAfterCompletion: 'DELETE',
    Target: {
      Arn: StartFunctionArn,
      RoleArn: SchedulerRoleArn,
      Input: JSON.stringify({ projectId, campaignId }),
    },
  }));
}

export async function startCampaign(event) {
  const { projectId, campaignId } = typeof event?.body === 'string' ? JSON.parse(event.body) : event || {};
  if (!projectId || !campaignId) throw new ApiError(400, 'INVALID_SCHEDULE_EVENT', 'projectId and campaignId are required');
  const campaign = await startDependencies.getCampaign(projectId, campaignId);
  if (!campaign || campaign.state !== 'scheduled') return { started: false, reason: 'not-eligible' };
  if (!campaign.scheduledAt || Date.parse(campaign.scheduledAt) > Date.now()) return { started: false, reason: 'not-due' };
  try {
    await startDependencies.updateCampaignState(projectId, campaignId, 'scheduled', 'queued');
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') return { started: false, reason: 'already-started' };
    throw error;
  }
  await startDependencies.sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: campaignQueueMessage(projectId, campaignId) }));
  return { started: true, campaignId };
}

export async function startCampaignHandler(event) {
  try {
    return { statusCode: 200, body: JSON.stringify(await startCampaign(event)) };
  } catch (error) {
    console.error(JSON.stringify({ event: 'scheduled_campaign_start_failed', error: error.message, errorName: error.name }));
    return { statusCode: error.statusCode || 500, body: JSON.stringify({ error: error.message }) };
  }
}

export async function authorize(event, lookup = getApiKey) {
  const rawKey = header(event, 'x-api-key');
  if (!rawKey) throw new ApiError(401, 'API_KEY_REQUIRED', 'x-api-key is required');
  const apiKey = await lookup(apiKeyHash(rawKey, process.env.API_KEY_PEPPER));
  if (!apiKey || apiKey.revokedAt) throw new ApiError(401, 'INVALID_API_KEY', 'Invalid API key');
  return apiKey;
}

export async function handler(event) {
  const correlationId = requestId(event);
  try {
    const method = event.requestContext?.http?.method || event.httpMethod;
    // HTTP API managed CORS normally answers preflight before Lambda. Keep this
    // short-circuit for direct Lambda invocations and any future route changes;
    // OPTIONS must never require an application API key.
    if (method === 'OPTIONS') return json(204, {}, correlationId);
    const apiKey = await authorize(event);
    const campaignId = event.pathParameters?.campaignId;
    const action = event.pathParameters?.action;
    if (method === 'GET') {
      if (campaignId) {
        const campaign = await getCampaign(apiKey.projectId, campaignId);
        return campaign ? json(200, campaign, correlationId) : json(404, { error: 'Campaign not found', code: 'CAMPAIGN_NOT_FOUND' }, correlationId);
      }
      const result = await listCampaigns(apiKey.projectId);
      return json(200, { items: result.Items || [], nextToken: result.LastEvaluatedKey || null }, correlationId);
    }
    if (campaignId && action) {
      const campaign = await getCampaign(apiKey.projectId, campaignId);
      if (!campaign) return json(404, { error: 'Campaign not found', code: 'CAMPAIGN_NOT_FOUND' }, correlationId);
      const transitions = { pause: ['scheduled', 'queued', 'running'], resume: ['paused'], cancel: ['scheduled', 'queued', 'running', 'paused'] };
      const target = action === 'pause' ? 'paused' : action === 'resume' ? (campaign.scheduledAt && Date.parse(campaign.scheduledAt) > Date.now() ? 'scheduled' : 'queued') : action === 'cancel' ? 'cancelled' : null;
      if (!target || !transitions[action].includes(campaign.state)) throw new ApiError(409, 'INVALID_CAMPAIGN_STATE', 'Campaign cannot perform this action in its current state');
      await updateCampaignState(apiKey.projectId, campaignId, campaign.state, target);
      if (action === 'resume' && target === 'queued') await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: campaignQueueMessage(apiKey.projectId, campaignId) }));
      return json(202, { campaignId, state: target }, correlationId);
    }
    if (method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    const body = parseJson(event.body);
    if (typeof body.template !== 'string' || !body.template.trim()) throw new ApiError(400, 'INVALID_REQUEST', 'template is required');
    const templateSlug = body.template.trim();
    const channel = body.channel || deliveryChannels.email;
    const recipients = normalizeCampaignRecipients(body);
    const push = channel === deliveryChannels.push ? normalizePushContent(body.push) : undefined;
    if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) throw new ApiError(400, 'INVALID_REQUEST', 'data must be an object');
    const template = await getTemplate(apiKey.projectId, templateSlug);
    if (!template || template.state !== 'published') throw new ApiError(404, 'TEMPLATE_NOT_FOUND', 'Published template not found');
    renderTemplate(template.subject, body.data); renderTemplate(template.html, body.data); if (template.text) renderTemplate(template.text, body.data);
    const dltVariableMapping = channel === deliveryChannels.sms ? body.dltVariableMapping : undefined;
    if (channel === deliveryChannels.sms && (!Array.isArray(dltVariableMapping) || dltVariableMapping.length === 0 || dltVariableMapping.some((name) => !template.variables.includes(name) || typeof name !== 'string'))) throw new ApiError(400, 'INVALID_DLT_VARIABLE_MAPPING', 'dltVariableMapping must list existing template variables in order');
    const statuses = await Promise.all(recipients.map((recipient) => getRecipient(apiKey.projectId, recipient)));
    if (statuses.some((status) => status?.status === 'suppressed' || status?.status === 'opted_out')) throw new ApiError(409, 'RECIPIENT_SUPPRESSED', 'A recipient is suppressed');
    for (let index = 0; index < recipients.length; index += 1) await consumeRateLimit(apiKey.projectId, apiKey.maxPerMinute || 60);
    const scheduledAt = body.scheduledAt === undefined ? undefined : validateScheduledAt(body.scheduledAt);
    const newCampaignId = newId('cmp'); const createdAt = new Date().toISOString();
    const campaign = { PK: key.project(apiKey.projectId), SK: key.campaign(newCampaignId), campaignId: newCampaignId, projectId: apiKey.projectId, organizationId: apiKey.organizationId, templateSlug: template.slug, templateVersion: template.version, channel, data: body.data, ...(dltVariableMapping ? { dltVariableMapping } : {}), ...(push ? { push } : {}), ...(scheduledAt ? { scheduledAt } : {}), state: scheduledAt ? 'scheduled' : 'queued', total: recipients.length, processed: 0, successful: 0, failed: 0, pending: recipients.length, createdAt, updatedAt: createdAt };
    await createCampaign({ campaign, recipients });
    if (scheduledAt) {
      try {
        await createCampaignSchedule({ projectId: apiKey.projectId, campaignId: newCampaignId, scheduledAt });
      } catch (error) {
        try { await updateCampaignState(apiKey.projectId, newCampaignId, 'scheduled', 'failed'); } catch (markError) { console.error(JSON.stringify({ event: 'campaign_schedule_failure_unrecorded', campaignId: newCampaignId, errorName: markError.name })); }
        throw error;
      }
      return json(202, { campaignId: newCampaignId, state: 'scheduled', scheduledAt, total: recipients.length }, correlationId);
    }
    await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: campaignQueueMessage(apiKey.projectId, newCampaignId) }));
    return json(202, { campaignId: newCampaignId, state: 'queued', total: recipients.length }, correlationId);
  } catch (error) {
    return errorResponse(error, correlationId);
  }
}
