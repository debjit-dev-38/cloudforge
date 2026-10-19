export const DEFAULT_TEMPLATES = Object.freeze([
  { slug: 'welcome-onboarding', source: 'system', subject: 'Welcome to Ember Studio, {{name}}', html: '<p>Welcome {{name}}, your account is now ready.</p>', text: 'Welcome {{name}}, your account is now ready.', variables: ['name', 'companyName'] },
  { slug: 'otp-verification', source: 'system', subject: 'Your one-time security code is {{code}}', html: '<p>Your verification code is: <strong>{{code}}</strong></p>', text: 'Your verification code is: {{code}}', variables: ['code', 'expiresMinutes'] },
  { slug: 'invoice-receipt', source: 'system', subject: 'Payment receipt for invoice #{{invoiceId}}', html: '<p>Thank you for your payment of {{amount}}.</p>', text: 'Thank you for your payment of {{amount}}.', variables: ['invoiceId', 'amount', 'dueDate'] },
]);
