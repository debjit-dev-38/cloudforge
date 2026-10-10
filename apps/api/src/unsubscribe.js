// Recipient unsubscribe Lambda handler.
import { apiKeyHash, errorResponse, json, parseJson, requestId, validateEmail, verifyUnsubscribeToken } from './core.js';
import { getApiKey, setRecipientStatus } from './store.js';

function header(event, name) {
  return event.headers?.[name] || event.headers?.[name.toLowerCase()];
}

export async function handler(event) {
  const correlationId = requestId(event);
  const respond = (statusCode, body) => json(statusCode, body, correlationId);
  try {
    const body = parseJson(event.body);
    const token = body?.token || event.queryStringParameters?.token;
    let projectId = body?.projectId;
    let email = body?.email;

    if (token) {
      const payload = verifyUnsubscribeToken(token, process.env.UNSUBSCRIBE_SECRET);
      if ((projectId && projectId !== payload.projectId) || (email && validateEmail(email) !== payload.email)) {
        return respond(401, { error: 'Unsubscribe token does not match the request', code: 'INVALID_UNSUBSCRIBE_TOKEN' });
      }
      projectId = payload.projectId;
      email = payload.email;
    } else {
      if (typeof projectId !== 'string') return respond(400, { error: 'projectId is required', code: 'INVALID_REQUEST' });
      email = validateEmail(email);
      const rawKey = header(event, 'x-api-key');
      if (!rawKey) return respond(401, { error: 'A valid unsubscribe token or project API key is required', code: 'AUTHORIZATION_REQUIRED' });
      const apiKey = await getApiKey(apiKeyHash(rawKey, process.env.API_KEY_PEPPER));
      if (!apiKey || apiKey.revokedAt || apiKey.projectId !== projectId) return respond(401, { error: 'Invalid project authorization', code: 'INVALID_AUTHORIZATION' });
    }

    await setRecipientStatus(projectId, email, 'opted_out', token ? 'signed_recipient_request' : 'authorized_project_request');
    console.log(JSON.stringify({ event: 'recipient_opted_out', requestId: correlationId, projectId, email }));
    return respond(200, { status: 'opted_out' });
  } catch (error) {
    console.error(JSON.stringify({ event: 'unsubscribe_error', requestId: correlationId, error: error.message, errorName: error.name }));
    return errorResponse(error, correlationId);
  }
}
