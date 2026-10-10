import { createSign } from 'node:crypto';
import { createChannelProvider, deliveryChannels } from '../delivery.js';

function parseServiceAccount(value) {
  try {
    const account = JSON.parse(value || '{}');
    if (!account.client_email || !account.private_key) throw new Error('FCM service account is incomplete');
    return account;
  } catch (error) {
    throw new Error(`Invalid FCM service account configuration: ${error.message}`);
  }
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

export function createGoogleAccessTokenProvider({ serviceAccountJson = process.env.FCM_SERVICE_ACCOUNT_JSON, fetchImpl = globalThis.fetch } = {}) {
  const account = parseServiceAccount(serviceAccountJson);
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
  return async () => {
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = base64Url(JSON.stringify({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }));
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claim}`);
    const assertion = `${header}.${claim}.${signer.sign(account.private_key, 'base64url')}`;
    const response = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.access_token) {
      const error = new Error(payload.error_description || 'Unable to obtain FCM access token');
      error.code = payload.error || `HTTP_${response.status}`;
      error.status = response.status;
      throw error;
    }
    return payload.access_token;
  };
}

export function createFcmRestClient({ projectId = process.env.FCM_PROJECT_ID, getAccessToken, fetchImpl = globalThis.fetch } = {}) {
  if (!projectId) throw new Error('FCM_PROJECT_ID is required');
  const accessToken = getAccessToken || createGoogleAccessTokenProvider();
  if (typeof accessToken !== 'function' || typeof fetchImpl !== 'function') throw new Error('FCM client configuration is invalid');
  return {
    async sendMessage(message) {
      const response = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      const payload = await response.json();
      if (!response.ok) {
        const details = payload.error || {};
        const error = new Error(details.message || 'FCM push delivery failed');
        error.name = details.status || 'FcmError';
        error.code = details.status || `HTTP_${response.status}`;
        error.status = response.status;
        error.disableToken = details.status === 'UNREGISTERED' || details.status === 'NOT_FOUND';
        throw error;
      }
      return payload;
    },
  };
}

export function createFcmPushProvider({ client, projectId = process.env.FCM_PROJECT_ID, serviceAccountJson = process.env.FCM_SERVICE_ACCOUNT_JSON } = {}) {
  const fcmClient = client || createFcmRestClient({ projectId, getAccessToken: createGoogleAccessTokenProvider({ serviceAccountJson }) });
  return createChannelProvider({
    channel: deliveryChannels.push,
    provider: 'fcm',
    send: async ({ delivery, content }) => {
      const response = await fcmClient.sendMessage({
        token: delivery.recipient,
        notification: { title: content.title, body: content.body },
        data: content.data || {},
        ...(content.deepLink ? { webpush: { fcmOptions: { link: content.deepLink } } } : {}),
      });
      return { providerMessageId: response.name, metadata: { provider: 'fcm' } };
    },
  });
}
