import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { createChannelProvider, deliveryChannels } from '../delivery.js';

export function createSesEmailProvider({ client = new SESv2Client({}), fromEmailAddress, configurationSetName } = {}) {
  return createChannelProvider({
    channel: deliveryChannels.email,
    provider: 'ses',
    send: async ({ delivery, content }) => {
      const result = await client.send(new SendEmailCommand({
        FromEmailAddress: fromEmailAddress,
        Destination: { ToAddresses: [delivery.recipient] },
        Content: { Simple: { Subject: { Data: content.subject }, Body: { Html: { Data: content.html }, Text: { Data: content.text } } } },
        ConfigurationSetName: configurationSetName,
        EmailTags: [{ Name: 'notificationId', Value: delivery.notificationId }, { Name: 'projectId', Value: delivery.projectId }],
      }));
      return result;
    },
  });
}
