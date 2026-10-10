// Shared domain helpers for the Lambda application.
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const statusRank = {
  queued: 0,
  processing: 1,
  sent: 2,
  delivered: 3,
  bounced: 4,
  complained: 4,
  failed: 4,
  suppressed: 4,
};

const knownRetryableErrors = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'InternalFailure',
  'NetworkingError',
  'RequestTimeout',
  'ServiceUnavailableException',
  'ThrottlingException',
  'TooManyRequestsException',
  'TimeoutError',
  '20429',
  '30001',
  '30008',
  '30009',
  'UNAVAILABLE',
  'INTERNAL',
  'RESOURCE_EXHAUSTED',
  'DEADLINE_EXCEEDED',
]);

export class ApiError extends Error {
  constructor(statusCode, code, message, options = {}) {
    super(message, options);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function apiKeyHash(apiKey, pepper) {
  return createHash('sha256').update(`${pepper}:${apiKey}`).digest('hex');
}

export function newId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

export function requestId(event) {
  return event?.requestContext?.requestId || header(event, 'x-request-id') || newId('req');
}

export function json(statusCode, body, correlationId) {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  if (correlationId) headers['x-request-id'] = correlationId;
  return { statusCode, headers, body: JSON.stringify(body) };
}

export function errorResponse(error, correlationId) {
  const normalized = normalizeError(error);
  return json(normalized.statusCode, {
    error: normalized.message,
    code: normalized.code,
    requestId: correlationId,
  }, correlationId);
}

export function normalizeError(error) {
  if (error instanceof ApiError) {
    return { statusCode: error.statusCode, code: error.code, message: error.message };
  }
  if (error?.code === 'RATE_LIMITED') return { statusCode: 429, code: 'RATE_LIMITED', message: error.message };
  if (error?.code === 'RECIPIENT_SUPPRESSED') return { statusCode: 409, code: error.code, message: error.message };
  if (error?.name === 'ConditionalCheckFailedException') return { statusCode: 409, code: 'CONFLICT', message: 'The requested resource is in use.' };
  if (error?.name === 'TransactionCanceledException') return { statusCode: 409, code: 'CONFLICT', message: 'The request conflicts with an existing resource.' };

  const message = error?.message || '';
  if (/valid email|valid JSON|data must be|is required|idempotencyKey|Missing template variable|slug must contain/i.test(message)) {
    return { statusCode: 400, code: 'INVALID_REQUEST', message };
  }
  if (/Published template not found|Project not found|Template version unavailable|API key not found/i.test(message)) {
    return { statusCode: 404, code: 'NOT_FOUND', message };
  }
  return { statusCode: 500, code: 'INTERNAL_ERROR', message: 'Internal error' };
}

export function parseJson(body) {
  try {
    return JSON.parse(body || '{}');
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'Request body must be valid JSON');
  }
}

export function validateEmail(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new ApiError(400, 'INVALID_EMAIL', 'recipient must be a valid email address');
  }
  return normalized;
}

export function templateVariables(template) {
  return [...new Set([...template.matchAll(/{{\s*([a-zA-Z][\w.]*)\s*}}/g)].map((match) => match[1]))];
}

export function getPath(data, path) {
  return path.split('.').reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), data);
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

export function renderTemplate(template, data) {
  const variables = templateVariables(template);
  for (const variable of variables) {
    if (getPath(data, variable) === undefined) throw new ApiError(400, 'MISSING_TEMPLATE_VARIABLE', `Missing template variable: ${variable}`);
  }
  return template.replace(/{{\s*([a-zA-Z][\w.]*)\s*}}/g, (_, path) => escapeHtml(getPath(data, path)));
}

export function canTransition(current, next) {
  if (current === next) return true;
  if (['bounced', 'complained', 'failed', 'suppressed'].includes(current)) return false;
  return statusRank[next] >= statusRank[current];
}

export function isRetryableProviderError(error) {
  const httpStatus = error?.$metadata?.httpStatusCode || error?.statusCode || error?.status;
  if ([408, 425, 429].includes(httpStatus) || httpStatus >= 500) return true;
  if (knownRetryableErrors.has(error?.name) || knownRetryableErrors.has(String(error?.code))) return true;
  return /temporar|timeout|timed out|throttl|network|unavailable|connection reset/i.test(error?.message || '');
}

export function deliveryFailureStatus(error) {
  return isRetryableProviderError(error) ? 'queued' : 'failed';
}

export function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor(value) {
  if (!value) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) || typeof decoded.PK !== 'string' || typeof decoded.SK !== 'string') throw new Error('invalid cursor');
    return decoded;
  } catch {
    throw new ApiError(400, 'INVALID_CURSOR', 'cursor must be a valid pagination cursor');
  }
}

export function createUnsubscribeToken({ projectId, email, expiresAt }, secret) {
  if (!secret) throw new ApiError(500, 'CONFIGURATION_ERROR', 'Unsubscribe signing is not configured');
  const payload = Buffer.from(JSON.stringify({ projectId, email: validateEmail(email), exp: expiresAt }), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyUnsubscribeToken(token, secret, now = Math.floor(Date.now() / 1000)) {
  if (!secret || typeof token !== 'string') throw new ApiError(401, 'INVALID_UNSUBSCRIBE_TOKEN', 'A valid unsubscribe token is required');
  const [payload, signature] = token.split('.');
  if (!payload || !signature) throw new ApiError(401, 'INVALID_UNSUBSCRIBE_TOKEN', 'A valid unsubscribe token is required');
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new ApiError(401, 'INVALID_UNSUBSCRIBE_TOKEN', 'A valid unsubscribe token is required');
  }
  try {
    const result = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!result.projectId || !result.email || !Number.isInteger(result.exp) || result.exp <= now) throw new Error('expired');
    return { projectId: result.projectId, email: validateEmail(result.email), expiresAt: result.exp };
  } catch (error) {
    throw new ApiError(401, 'INVALID_UNSUBSCRIBE_TOKEN', 'A valid unsubscribe token is required');
  }
}

function header(event, name) {
  return event?.headers?.[name] || event?.headers?.[name.toLowerCase()];
}
