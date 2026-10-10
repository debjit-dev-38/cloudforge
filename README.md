# AWS Notification MVP

A deliberately small, multi-tenant transactional-email service. It is isolated from Novu production code so it can be deployed as an independent AWS stack.

## Included

- Cognito-authenticated operator API for creating projects, templates, and one-time-visible API keys.
- `POST /v1/notifications`, authenticated with a per-project API key and optional idempotency key.
- DynamoDB single-table persistence, tenant-scoped lookups, hashed API keys, template versions, delivery history, recipient opt-outs/suppression, and a per-project minute quota.
- SQS + DLQ delivery pipeline, SES sender Lambda, and SES → SNS feedback processor for deliveries, bounces, and complaints.
- Bulk campaigns for up to 1,000 normalized recipients, with queued worker processing and pause, resume, and cancel controls.
- Email, SMS, and Firebase push delivery through one-channel-per-notification and one-channel-per-campaign payloads.
- CloudWatch alarms for API errors and DLQ depth, plus an S3/CloudFront static dashboard shell.

## Deploy

Prerequisites: an AWS account/credentials, a verified SES sender identity, and the AWS SAM CLI. Deploy in an SES Region with production sending enabled.

```powershell
cd playground/notification-mvp
sam build --template-file infra/template.yaml
sam deploy --stack-name notification-mvp --profile notification-mvp --region ap-southeast-2 --parameter-overrides 'SendingEmail=deyricky4@gmail.com' 'ApiKeyPepper=<existing-32+-character-pepper>' 'UnsubscribeSecret=<existing-32+-character-secret>' 'AllowedOrigins=https://your-dashboard-domain.example' 'CognitoDomainPrefix=notification-mvp-583372808076'
```

After deployment, upload the static dashboard and invalidate its cache:

```powershell
$bucket = aws cloudformation describe-stacks --stack-name notification-mvp --profile notification-mvp --region ap-southeast-2 --query "Stacks[0].Outputs[?OutputKey=='DashboardBucket'].OutputValue | [0]" --output text
$distributionId = aws cloudformation list-stack-resources --stack-name notification-mvp --profile notification-mvp --region ap-southeast-2 --query "StackResourceSummaries[?LogicalResourceId=='DashboardDistribution'].PhysicalResourceId | [0]" --output text
aws s3 sync apps/dashboard/ "s3://$bucket" --delete --profile notification-mvp --region ap-southeast-2
aws cloudfront create-invalidation --distribution-id $distributionId --paths '/*' --profile notification-mvp
```

The deployed CloudFront URL is configured as a Cognito callback and logout URL. Open the dashboard and choose **Login with Cognito**; the dashboard retrieves the public OAuth client metadata from the API and keeps the resulting access token in `sessionStorage`. It never asks an operator to paste or display an access token.

The API key returned when creating a key is also kept only in the current browser session so it can send a test email. Copy it at creation time: the raw key cannot be retrieved later.

Unsubscribe requests must use either a signed token created by a trusted sender or a project API key. Keep `UnsubscribeSecret` stable across deployments so previously issued tokens remain verifiable until they expire.

## Public API example

```bash
curl -X POST "$API_URL/v1/notifications" \
  -H "content-type: application/json" \
  -H "x-api-key: nfy_your_key" \
  -H "idempotency-key: order-123-email" \
  -d '{"template":"welcome","recipient":"person@example.com","data":{"name":"Sam"}}'
```

### Campaigns

The dashboard workflow is: create or select a published template, open **Campaigns**, choose one delivery channel, paste recipients separated by commas or new lines, review the deduplicated summary, and launch. Campaigns are asynchronous; use the list refresh or campaign detail view to follow progress and use pause, resume, or cancel for queued and running work. One campaign always uses one channel.

```bash
curl -X POST "$API_URL/v1/campaigns" \
  -H "content-type: application/json" \
  -H "x-api-key: nfy_your_key" \
  -d '{"template":"welcome","channel":"email","recipients":["sam@example.com","lee@example.com"],"data":{"name":"Member"}}'
```

Email, SMS, and push campaign payloads use the same endpoint and differ only by their channel and recipient/content requirements:

```json
{"template":"otp","channel":"sms","recipients":["+14155552671"],"data":{"code":"123456"}}
```

```json
{"template":"app-update","channel":"push","recipients":["person@example.com"],"data":{"version":"3.0"},"push":{"title":"Update available","body":"Install the latest version","deepLink":"https://app.example.com/update","data":{"source":"campaign"}}}
```

Each push campaign requires `push.title` and `push.body`; `push.deepLink` and `push.data` are optional. Email recipients are normalized as email addresses, SMS recipients as E.164 phone numbers, and push recipients as email identifiers associated with registered devices.

### Device registration

```bash
curl -X POST "$API_URL/v1/devices" \
  -H "content-type: application/json" \
  -H "x-api-key: nfy_your_key" \
  -d '{"recipient":"person@example.com","token":"fcm_token_from_client_sdk","platform":"android"}'

curl -X DELETE "$API_URL/v1/devices" \
  -H "content-type: application/json" \
  -H "x-api-key: nfy_your_key" \
  -d '{"recipient":"person@example.com","token":"fcm_token_from_client_sdk","platform":"android"}'
```

## Local verification

`pnpm test` runs dependency-free tests for template rendering, input validation, hashing, and status transitions. Lambda handlers use the AWS SDK v3 supplied by the managed Node.js Lambda runtime; use SAM or deployed AWS services for integration testing.

## Twilio SMS provider configuration

The provider reads `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER`. The sender and recipient must use E.164 format; recipient values may include common formatting characters and are normalized before sending.

For production, store the Twilio account SID, auth token, and sender number in AWS Secrets Manager (or an equivalent secure secret store) and inject them into the Lambda environment through the deployment/secret integration. Never commit them to source, `samconfig`, local environment files, or logs.

SMS and push are opt-in channels; omitted `channel` values continue to use the existing email path.

## Firebase push configuration

Push delivery uses `FCM_PROJECT_ID` and `FCM_SERVICE_ACCOUNT_JSON`. The service-account JSON must be injected at runtime from AWS Secrets Manager or another approved secret store; never commit it or place it in source, logs, or ordinary configuration files. The SAM parameters `FcmProjectId` and `FcmServiceAccountJson` are available for deployment overrides; use a Secrets Manager dynamic reference for the latter in production.

Register devices with the API-key-authorized `POST /v1/devices` endpoint using `{ "recipient": "person@example.com", "token": "...", "platform": "ios" }`; remove them with `DELETE /v1/devices` using the same recipient and token. Push notifications use `channel: "push"` and a `push` object containing `title`, `body`, optional string-convertible `data`, and optional `deepLink`.

## Provider configuration requirements

Email requires a verified SES sender identity and, in the SES sandbox, verified recipient addresses. SMS requires Twilio account credentials and an E.164 sender number. Push requires an FCM project ID, a Firebase service-account JSON secret, and a registered device token. Keep provider credentials in Secrets Manager or an equivalent secret store; do not commit them, place them in ordinary configuration, or log them.

Campaigns intentionally do not mix channels. Create separate campaigns when the same audience needs email, SMS, and push messages, because each channel has different recipient validation and provider delivery semantics.
