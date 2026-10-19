// SQS-triggered SES delivery Lambda handler.
import { campaignQueueMessage, createDelivery, deliveryChannels, sanitizeProviderFailure, selectProvider } from './delivery.js';
import { createSesEmailProvider } from './providers/ses-email-provider.js';
import { createTwilioSmsProvider } from './providers/twilio-sms-provider.js';
import { createFast2SmsProvider } from './providers/fast2sms-provider.js';
import { createFcmPushProvider } from './providers/fcm-push-provider.js';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { renderTemplate } from './core.js';
import { claimCampaignRecipient, completeCampaignRecipient, disableDevice, get, getCampaign, getRecipient, getTemplateVersion, key, listDevices, listPendingCampaignRecipients, releaseCampaignRecipient, updateCampaignState, updateStatus } from './store.js';

const emailProvider = createSesEmailProvider({
  fromEmailAddress: process.env.SENDING_EMAIL,
  configurationSetName: process.env.SES_CONFIGURATION_SET,
});
const sqs = new SQSClient({});
const QueueUrl = process.env.QUEUE_URL;
let smsProvider;
let pushProvider;

const dependencies = { get, getCampaign, getRecipient, getTemplateVersion, listDevices, listPendingCampaignRecipients, claimCampaignRecipient, completeCampaignRecipient, releaseCampaignRecipient, updateCampaignState, updateStatus, disableDevice, sqs, emailProvider };

export function setWorkerDependenciesForTests(overrides) {
  const previous = { ...dependencies };
  Object.assign(dependencies, overrides);
  return () => Object.assign(dependencies, previous);
}

function getSmsProvider() {
  smsProvider ||= process.env.SMS_PROVIDER === 'twilio' ? createTwilioSmsProvider() : createFast2SmsProvider();
  return smsProvider;
}

function getPushProvider() {
  pushProvider ||= createFcmPushProvider();
  return pushProvider;
}

function providerConfigurationError(error) {
  return /required|incomplete|configuration/i.test(error?.message || '');
}

async function processCampaignRecord({ projectId, campaignId }) {
  const campaign = await dependencies.getCampaign(projectId, campaignId);
  if (!campaign || campaign.state === 'scheduled' || campaign.state === 'paused' || campaign.state === 'cancelled' || campaign.state === 'completed') return;
  if (campaign.state === 'queued') {
    try { await dependencies.updateCampaignState(projectId, campaignId, 'queued', 'running'); } catch (error) { if (error.name !== 'ConditionalCheckFailedException') throw error; }
  }
  const current = await dependencies.getCampaign(projectId, campaignId);
  if (!current || current.state !== 'running') return;
  const template = await dependencies.getTemplateVersion(projectId, campaign.templateSlug, campaign.templateVersion);
  if (!template) throw new Error('Campaign template unavailable');
  const recipients = await dependencies.listPendingCampaignRecipients(projectId, campaignId, 25);
  if (!recipients.length) {
    const latest = await dependencies.getCampaign(projectId, campaignId);
    if (latest?.pending === 0) await dependencies.updateCampaignState(projectId, campaignId, 'running', 'completed');
    return;
  }
  let provider;
  try {
    provider = selectProvider(current.channel, { email: dependencies.emailProvider, sms: current.channel === deliveryChannels.sms ? getSmsProvider() : undefined, push: current.channel === deliveryChannels.push ? getPushProvider() : undefined });
  } catch (error) {
    if (!providerConfigurationError(error)) throw error;
    await dependencies.updateCampaignState(projectId, campaignId, current.state, 'failed');
    console.error(JSON.stringify({ event: 'campaign_provider_unavailable', projectId, campaignId, channel: current.channel, error: error.message }));
    return;
  }
  const content = current.channel === deliveryChannels.push ? current.push : { subject: renderTemplate(template.subject, current.data), html: renderTemplate(template.html, current.data), text: renderTemplate(template.text || template.html.replace(/<[^>]+>/g, ''), current.data), data: current.data, dltVariableMapping: current.dltVariableMapping };
  for (const item of recipients) {
    const liveCampaign = await dependencies.getCampaign(projectId, campaignId);
    if (!liveCampaign || liveCampaign.state !== 'running') return;
    const claimed = await dependencies.claimCampaignRecipient(projectId, campaignId, item.recipient);
    if (!claimed) continue;
    const suppressed = await dependencies.getRecipient(projectId, item.recipient);
    if (suppressed?.status === 'suppressed' || suppressed?.status === 'opted_out') { await dependencies.completeCampaignRecipient({ projectId, campaignId, recipient: item.recipient, status: 'failed', error: suppressed.status, claimToken: claimed.claimToken }); continue; }
    const targets = current.channel === deliveryChannels.push ? (await dependencies.listDevices(projectId, item.recipient)).filter((device) => device.status === 'active') : [{ token: item.recipient }];
    let delivered = false; let retryable = false; let failure; let failureCode; let providerMessageId;
    for (const target of targets) {
      const result = await provider.send({ delivery: { ...createDelivery({ notificationId: campaignId, projectId, organizationId: current.organizationId, recipient: target.token }, current.channel) }, content });
      if (result.outcome === 'success') { delivered = true; providerMessageId = result.providerMessageId; break; }
      if (result.outcome === 'simulated') { failure = 'SIMULATED_MODE'; failureCode = 'SIMULATED_MODE'; break; }
      if (result.disableToken) await dependencies.disableDevice(projectId, item.recipient, target.token, result.errorCode);
      retryable ||= result.retryable; failure = result.errorMessage; failureCode = result.errorCode;
    }
    if (retryable && !delivered) { await dependencies.releaseCampaignRecipient(projectId, campaignId, item.recipient, claimed.claimToken); throw new Error(failure || 'Campaign delivery retry'); }
    await dependencies.completeCampaignRecipient({ projectId, campaignId, recipient: item.recipient, status: delivered ? 'succeeded' : 'failed', error: delivered ? undefined : sanitizeProviderFailure(failureCode, failure || (targets.length ? 'Delivery failed' : 'No active devices')), providerMessageId: delivered ? providerMessageId : undefined, claimToken: claimed.claimToken });
  }
  const latest = await dependencies.getCampaign(projectId, campaignId);
  if (!latest || latest.state !== 'running') return;
  if (latest.pending > 0) await dependencies.sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: campaignQueueMessage(projectId, campaignId) }));
  else if ((await dependencies.listPendingCampaignRecipients(projectId, campaignId, 1)).length > 0) await dependencies.sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: campaignQueueMessage(projectId, campaignId) }));
  else await dependencies.updateCampaignState(projectId, campaignId, 'running', 'completed');
}

async function processRecord(record) {
  const message = JSON.parse(record.body);
  if (message.campaign) return processCampaignRecord(message);
  const { projectId, notificationId } = message;
  const notification = await get(key.project(projectId), key.notification(notificationId));
  if (!notification || notification.status !== 'queued') return;
  const channel = notification.channel || deliveryChannels.email;
  const recipient = await getRecipient(projectId, notification.recipient);
  if (recipient?.status === 'suppressed' || recipient?.status === 'opted_out') {
    await updateStatus(projectId, notificationId, 'queued', 'suppressed', { failureReason: recipient.status });
    return;
  }
  await updateStatus(projectId, notificationId, 'queued', 'processing');
  let content;
  let delivery;
  try {
    const template = await getTemplateVersion(projectId, notification.templateSlug, notification.templateVersion);
    if (!template) throw new Error('Template version unavailable');
    const subject = renderTemplate(template.subject, notification.data);
    const html = renderTemplate(template.html, notification.data);
    const text = renderTemplate(template.text || template.html.replace(/<[^>]+>/g, ''), notification.data);
    content = channel === deliveryChannels.push ? notification.push : { subject, html, text };
    delivery = createDelivery(notification, channel);
  } catch (error) {
    await updateStatus(projectId, notificationId, 'processing', 'failed', { failureReason: error.message, retryable: false });
    console.error(JSON.stringify({ event: 'notification_permanent_failure', projectId, notificationId, error: error.message, errorName: error.name }));
    return;
  }

  let provider;
  try {
    provider = selectProvider(channel, {
      email: emailProvider,
      sms: channel === deliveryChannels.sms ? getSmsProvider() : undefined,
      push: channel === deliveryChannels.push ? getPushProvider() : undefined,
    });
  } catch (error) {
    if (!providerConfigurationError(error)) throw error;
    await updateStatus(projectId, notificationId, 'processing', 'failed', { failureReason: error.message, retryable: false });
    console.error(JSON.stringify({ event: 'notification_provider_unavailable', projectId, notificationId, channel, error: error.message }));
    return;
  }
  const devices = channel === deliveryChannels.push ? (await listDevices(projectId, notification.recipient)).filter((device) => device.status === 'active') : [{ token: notification.recipient }];
  if (!devices.length) {
    await updateStatus(projectId, notificationId, 'processing', 'failed', { failureReason: 'No active devices registered', retryable: false });
    return;
  }
  const deliveredTokens = new Set(notification.pushDeliveredTokens || []);
  let retryError;
  let successCount = 0;
  const messageIds = [];
  let permanentFailureCount = 0;
  for (const device of devices) {
    if (channel === deliveryChannels.push && deliveredTokens.has(device.token)) continue;
    const targetDelivery = channel === deliveryChannels.push ? createDelivery({ ...notification, recipient: device.token }, channel) : delivery;
    const result = await provider.send({ delivery: targetDelivery, content });
    if (result.outcome === 'failure') {
      if (result.disableToken) await disableDevice(projectId, notification.recipient, device.token, result.errorCode);
      if (result.retryable) retryError = result;
      else permanentFailureCount += 1;
      console.error(JSON.stringify({ event: 'notification_delivery_failure', projectId, notificationId, provider: result.provider, error: result.errorMessage, errorCode: result.errorCode }));
      continue;
    }
    successCount += 1;
    if (channel === deliveryChannels.push) {
      deliveredTokens.add(device.token);
      messageIds.push(result.providerMessageId);
      await updateStatus(projectId, notificationId, 'processing', 'processing', { pushDeliveredTokens: [...deliveredTokens], lastFcmMessageId: result.providerMessageId });
    } else {
      await updateStatus(projectId, notificationId, 'processing', 'sent', { sesMessageId: result.providerMessageId });
    }
  }
  if (retryError) {
    await updateStatus(projectId, notificationId, 'processing', 'queued', { failureReason: retryError.errorMessage, retryable: true });
    const error = new Error(retryError.errorMessage);
    error.name = retryError.errorCode;
    throw error;
  }
  if (successCount > 0) {
    if (channel === deliveryChannels.push) await updateStatus(projectId, notificationId, 'processing', 'sent', { fcmMessageIds: messageIds });
    console.log(JSON.stringify({ event: 'notification_sent', projectId, notificationId, provider: provider.provider }));
    return;
  }
  await updateStatus(projectId, notificationId, 'processing', 'failed', { failureReason: 'All push deliveries failed', retryable: false, permanentFailureCount });
}

export async function handler(event) {
  const batchItemFailures = [];
  for (const record of event.Records || []) {
    try {
      await processRecord(record);
    } catch (error) {
      console.error(JSON.stringify({ event: 'notification_worker_error', messageId: record.messageId, error: error.message, errorName: error.name }));
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
