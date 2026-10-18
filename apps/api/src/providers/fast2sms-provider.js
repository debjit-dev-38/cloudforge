import { deliveryChannels } from '../delivery.js';

const ENDPOINT = 'https://www.fast2sms.com/dev/bulkV2';

export function normalizeIndianMobile(value) {
  const digits = String(value || '').replace(/\D/g, '');
  const normalized = digits.startsWith('91') ? digits.slice(2) : digits;
  if (!/^[6-9]\d{9}$/.test(normalized)) throw new Error('recipient must be a valid Indian mobile number');
  return normalized;
}

function retryable(status) { return status === 408 || status === 429 || status >= 500; }

export function createFast2SmsProvider({ apiKey = process.env.FAST2SMS_API_KEY, senderId = process.env.FAST2SMS_SENDER_ID, templateId = process.env.FAST2SMS_TEMPLATE_ID, mockMode = process.env.FAST2SMS_MOCK_MODE !== 'false', timeoutMs = Number(process.env.FAST2SMS_TIMEOUT_MS || 8000), fetchImpl = globalThis.fetch } = {}) {
  if (!senderId) throw new Error('FAST2SMS_SENDER_ID is required');
  if (!templateId) throw new Error('FAST2SMS_TEMPLATE_ID is required');
  if (!mockMode && !apiKey) throw new Error('FAST2SMS_API_KEY is required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) throw new Error('FAST2SMS_TIMEOUT_MS must be between 1000 and 30000');
  if (!mockMode && typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
  return {
    channel: deliveryChannels.sms,
    provider: 'fast2sms',
    async send({ delivery, content }) {
      const number = normalizeIndianMobile(delivery.recipient);
      const mapping = content?.dltVariableMapping;
      if (!Array.isArray(mapping) || !mapping.length || mapping.some((name) => typeof name !== 'string' || !name.trim())) throw new Error('DLT variable mapping is required');
      const values = mapping.map((name) => content.data?.[name]);
      if (values.some((value) => typeof value !== 'string' || !value.length)) throw new Error('Every DLT template variable must be a non-empty string');
      const variables_values = values.join('|');
      if (mockMode) return { outcome: 'simulated', provider: 'fast2sms', providerMessageId: null, metadata: { recipient: number, templateId } };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(ENDPOINT, { method: 'POST', headers: { Authorization: apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ sender_id: senderId, message: templateId, variables_values, route: 'dlt', numbers: number, sms_details: '1' }), signal: controller.signal });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) { const error = new Error(payload.message || `Fast2SMS HTTP ${response.status}`); error.code = `HTTP_${response.status}`; error.status = response.status; error.retryable = retryable(response.status); throw error; }
        if (payload.return !== true || !payload.request_id) { const error = new Error(payload.message || 'Fast2SMS rejected the request'); error.code = 'FAST2SMS_REJECTED'; error.retryable = false; throw error; }
        return { outcome: 'success', provider: 'fast2sms', providerMessageId: payload.request_id, metadata: { accepted: true, deliveryConfirmed: false } };
      } catch (error) {
        if (error.name === 'AbortError') { error.code = 'FAST2SMS_TIMEOUT'; error.retryable = true; error.message = 'Fast2SMS request timed out'; }
        error.retryable = error.retryable ?? false;
        throw error;
      } finally { clearTimeout(timer); }
    },
  };
}
