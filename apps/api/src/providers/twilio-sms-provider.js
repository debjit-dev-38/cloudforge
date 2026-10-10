import { createChannelProvider, deliveryChannels, normalizePhoneNumber } from '../delivery.js';

export { normalizePhoneNumber };

export function createTwilioRestClient({ accountSid, authToken, fetchImpl = globalThis.fetch } = {}) {
  if (!accountSid || !authToken) throw new Error('Twilio credentials are required');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
  return { messages: { async create({ from, to, body }) {
    const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: from, To: to, Body: body }),
    });
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.message || 'Twilio SMS delivery failed');
      error.name = 'TwilioError';
      error.code = payload.code || `HTTP_${response.status}`;
      error.status = response.status;
      error.moreInfo = payload.more_info;
      throw error;
    }
    return payload;
  } } };
}

export function createTwilioSmsProvider({ client, accountSid = process.env.TWILIO_ACCOUNT_SID, authToken = process.env.TWILIO_AUTH_TOKEN, fromNumber = process.env.TWILIO_FROM_NUMBER } = {}) {
  if (!fromNumber) throw new Error('TWILIO_FROM_NUMBER is required');
  const twilioClient = client || createTwilioRestClient({ accountSid, authToken });
  return createChannelProvider({
    channel: deliveryChannels.sms,
    provider: 'twilio',
    send: async ({ delivery, content }) => {
      const response = await twilioClient.messages.create({ from: fromNumber, to: normalizePhoneNumber(delivery.recipient), body: content.text || content.body || content.message });
      return { providerMessageId: response.sid, metadata: { status: response.status, errorCode: response.error_code || null } };
    },
  });
}
