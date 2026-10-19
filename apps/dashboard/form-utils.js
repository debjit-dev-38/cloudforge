const CHANNELS = ['email', 'sms', 'push'];

export function parseObjectJson(value, label) {
  if (!value.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed;
}

export function normalizePhone(value) {
  const normalized = value.trim().replace(/[\s().-]/g, '').replace(/^00/, '+');
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new Error('Enter a valid E.164 phone number.');
  return normalized;
}

export function validateRecipient(channel, value) {
  const recipient = value.trim();
  if (!recipient) throw new Error('A recipient is required.');
  if (channel === 'sms') return normalizePhone(recipient);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) throw new Error('Enter a valid recipient email address.');
  return recipient.toLowerCase();
}

export function parseRecipients(channel, value, limit = 1000) {
  const values = value.split(/[\n,]/).map(item => item.trim()).filter(Boolean);
  if (!values.length) throw new Error('Enter at least one recipient.');
  const unique = [];
  const seen = new Set();
  for (const value of values) {
    const recipient = validateRecipient(channel, value);
    if (!seen.has(recipient)) {
      seen.add(recipient);
      unique.push(recipient);
    }
  }
  if (unique.length > limit) throw new Error(`Campaigns support at most ${limit.toLocaleString()} unique recipients.`);
  return unique;
}

export function validateChannel(channel) {
  if (!CHANNELS.includes(channel)) throw new Error('Choose email, SMS, or push.');
  return channel;
}

export function buildPushPayload({ title, body, deepLink, data }) {
  if (!title.trim() || !body.trim()) throw new Error('Push title and body are required.');
  const push = { title: title.trim(), body: body.trim() };
  if (deepLink.trim()) push.deepLink = deepLink.trim();
  if (data && Object.keys(data).length) push.data = data;
  return push;
}

export function buildNotificationPayload({ template, channel, recipient, data, push }) {
  validateChannel(channel);
  const payload = { template: template.trim(), channel, recipient: validateRecipient(channel, recipient), data };
  if (channel === 'push') payload.push = push;
  return payload;
}

export function buildCampaignPayload({ template, channel, recipients, data, push, dltVariableMapping, scheduledAt }) {
  validateChannel(channel);
  const payload = { template: template.trim(), channel, recipients: parseRecipients(channel, recipients), data };
  if (channel === 'push') payload.push = push;
  if (channel === 'sms') {
    if (!Array.isArray(dltVariableMapping) || !dltVariableMapping.length || dltVariableMapping.some((value) => typeof value !== 'string' || !value.trim())) throw new Error('SMS requires an ordered DLT variable mapping.');
    payload.dltVariableMapping = dltVariableMapping.map((value) => value.trim());
  }

  if (scheduledAt) payload.scheduledAt = scheduledAt;
  return payload;
}

export function buildScheduledAt(date, time, now = Date.now()) {
  if (!date || !time) throw new Error('Choose a start date and time.');
  const parsed = new Date(`${date}T${time}`);
  if (Number.isNaN(parsed.getTime())) throw new Error('Choose a valid start date and time.');
  if (parsed.getTime() <= now) throw new Error('Scheduled start must be in the future.');
  return parsed.toISOString();
}

export function maskToken(token) {
  if (token.length <= 8) return '********';
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}
