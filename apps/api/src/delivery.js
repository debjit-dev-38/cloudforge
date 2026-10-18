import { ApiError, isRetryableProviderError, validateEmail } from './core.js';

export const deliveryChannels = Object.freeze({ email: 'email', sms: 'sms', push: 'push' });

export function normalizePhoneNumber(value) {
  if (typeof value !== 'string') throw new Error('recipient must be an E.164 phone number');
  const normalized = value.trim().replace(/[\s().-]/g, '').replace(/^00/, '+');
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new Error('recipient must be an E.164 phone number');
  return normalized;
}

export function normalizeChannelAndRecipient(body) {
  const channel = body.channel === undefined ? deliveryChannels.email : body.channel;
  if (![deliveryChannels.email, deliveryChannels.sms, deliveryChannels.push].includes(channel)) {
    throw new ApiError(400, 'INVALID_CHANNEL', 'channel must be email, sms, or push');
  }
  if (channel === deliveryChannels.email || channel === deliveryChannels.push) return { channel, recipient: validateEmail(body.recipient) };
  try {
    return { channel, recipient: normalizePhoneNumber(body.recipient) };
  } catch {
    throw new ApiError(400, 'INVALID_PHONE', 'recipient must be a valid E.164 phone number');
  }
}

export function normalizePushContent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'INVALID_PUSH_CONTENT', 'push must be an object');
  if (typeof value.title !== 'string' || !value.title.trim() || typeof value.body !== 'string' || !value.body.trim()) throw new ApiError(400, 'INVALID_PUSH_CONTENT', 'push.title and push.body are required');
  if (value.deepLink !== undefined && (typeof value.deepLink !== 'string' || !value.deepLink.trim())) throw new ApiError(400, 'INVALID_PUSH_CONTENT', 'push.deepLink must be a non-empty string');
  if (value.data !== undefined && (!value.data || typeof value.data !== 'object' || Array.isArray(value.data))) throw new ApiError(400, 'INVALID_PUSH_CONTENT', 'push.data must be an object');
  const data = Object.fromEntries(Object.entries(value.data || {}).map(([key, item]) => [key, String(item)]));
  return { title: value.title.trim(), body: value.body.trim(), data, ...(value.deepLink ? { deepLink: value.deepLink } : {}) };
}

export function normalizeCampaignRecipients(body) {
  if (!Array.isArray(body.recipients) || !body.recipients.length || body.recipients.length > 1000) throw new ApiError(400, 'INVALID_RECIPIENTS', 'recipients must contain between 1 and 1000 entries');
  const unique = new Map();
  for (const value of body.recipients) {
    const normalized = normalizeChannelAndRecipient({ channel: body.channel, recipient: value }).recipient;
    unique.set(normalized, normalized);
  }
  return [...unique.values()];
}

export function campaignQueueMessage(projectId, campaignId) {
  return JSON.stringify({ projectId, campaignId, campaign: true });
}

export function queueMessage(projectId, notificationId, channel = deliveryChannels.email) {
  const payload = { projectId, notificationId };
  if (channel !== deliveryChannels.email) payload.channel = channel;
  return JSON.stringify(payload);
}

export function selectProvider(channel, providers) {
  if (channel === deliveryChannels.email) return providers.email;
  if (channel === deliveryChannels.sms) return providers.sms;
  if (channel === deliveryChannels.push) return providers.push;
  throw new Error(`Unsupported notification channel: ${channel}`);
}

export function createDelivery(notification, channel = deliveryChannels.email) {
  if (!notification?.notificationId || !notification?.projectId || !notification?.recipient) {
    throw new Error('A delivery requires notificationId, projectId, and recipient');
  }
  return {
    deliveryId: `${notification.notificationId}:${channel}`,
    notificationId: notification.notificationId,
    projectId: notification.projectId,
    organizationId: notification.organizationId,
    channel,
    recipient: notification.recipient,
    status: 'processing',
  };
}

export function createChannelProvider({ channel, provider, send }) {
  if (!channel || !provider || typeof send !== 'function') throw new Error('A provider requires channel, provider, and send');
  return {
    channel,
    provider,
    async send(input) {
      try {
        const response = await send(input);
        return normalizeProviderSuccess({ provider, response });
      } catch (error) {
        return normalizeProviderFailure({ provider, error });
      }
    },
  };
}

export function normalizeProviderSuccess({ provider, response }) {
  return {
    outcome: 'success',
    provider,
    providerMessageId: response?.MessageId || response?.providerMessageId,
    metadata: response?.metadata || {},
  };
}

export function normalizeProviderFailure({ provider, error }) {
  const result = {
    outcome: 'failure',
    provider,
    errorCode: error?.code || error?.name || 'PROVIDER_ERROR',
    errorMessage: error?.message || 'Provider delivery failed',
    retryable: isRetryableProviderError(error),
  };
  if (error?.disableToken) result.disableToken = true;
  return result;
}

export function sanitizeProviderFailure(errorCode, errorMessage) {
  const sanitized = String(errorMessage || 'Provider delivery failed')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[redacted recipient]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
  return `${errorCode || 'PROVIDER_ERROR'}: ${sanitized}`;
}
