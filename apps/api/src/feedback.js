// SES SNS feedback Lambda handler.
import { setRecipientStatus, updateStatus } from './store.js';

const typeToStatus = { Delivery: 'delivered', Bounce: 'bounced', Complaint: 'complained' };

export async function handler(event) {
  for (const record of event.Records || []) {
    const envelope = JSON.parse(record.Sns.Message);
    const eventType = envelope.eventType || envelope.notificationType;
    const status = typeToStatus[eventType];
    if (!status) continue;
    const tags = envelope.mail?.tags || {};
    const projectId = tags.projectId?.[0];
    const notificationId = tags.notificationId?.[0];
    if (!projectId || !notificationId) continue;
    const recipients = eventType === 'Bounce' ? envelope.bounce?.bouncedRecipients : eventType === 'Complaint' ? envelope.complaint?.complainedRecipients : envelope.delivery?.recipients;
    for (const entry of recipients || []) {
      const email = typeof entry === 'string' ? entry : entry.emailAddress;
      if (eventType === 'Bounce' || eventType === 'Complaint') await setRecipientStatus(projectId, email, 'suppressed', eventType.toLowerCase());
    }
    try {
      await updateStatus(projectId, notificationId, 'sent', status, { feedbackAt: new Date().toISOString() });
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
    }
  }
}
