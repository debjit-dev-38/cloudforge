import { ApiError, apiKeyHash, errorResponse, json, parseJson, requestId, validateEmail } from './core.js';
import { getApiKey, getRecipient, registerDevice, removeDevice } from './store.js';

function header(event, name) {
  return event.headers?.[name] || event.headers?.[name.toLowerCase()];
}

function validateToken(value) {
  if (typeof value !== 'string' || value.length < 20 || value.length > 4096) {
    throw new ApiError(400, 'INVALID_REQUEST', 'token must be between 20 and 4096 characters');
  }
  return value;
}

async function authorize(event) {
  const rawKey = header(event, 'x-api-key');
  if (!rawKey) throw new ApiError(401, 'API_KEY_REQUIRED', 'x-api-key is required');
  const apiKey = await getApiKey(apiKeyHash(rawKey, process.env.API_KEY_PEPPER));
  if (!apiKey || apiKey.revokedAt) throw new ApiError(401, 'INVALID_API_KEY', 'Invalid API key');
  return apiKey;
}

export async function handler(event) {
  const correlationId = requestId(event);
  try {
    const apiKey = await authorize(event);
    const body = parseJson(event.body);
    const recipient = validateEmail(body.recipient);
    const token = validateToken(body.token);
    const recipientStatus = await getRecipient(apiKey.projectId, recipient);
    if (recipientStatus?.status === 'suppressed' || recipientStatus?.status === 'opted_out') {
      return json(409, { error: 'Recipient is suppressed', code: 'RECIPIENT_SUPPRESSED' }, correlationId);
    }
    if (event.requestContext?.http?.method === 'DELETE' || event.httpMethod === 'DELETE') {
      await removeDevice(apiKey.projectId, recipient, token);
      return json(200, { status: 'removed' }, correlationId);
    }
    await registerDevice({ projectId: apiKey.projectId, organizationId: apiKey.organizationId, recipient, token, platform: body.platform });
    return json(201, { status: 'registered' }, correlationId);
  } catch (error) {
    console.error(JSON.stringify({ event: 'device_api_error', requestId: correlationId, error: error.message, errorName: error.name }));
    return errorResponse(error, correlationId);
  }
}
