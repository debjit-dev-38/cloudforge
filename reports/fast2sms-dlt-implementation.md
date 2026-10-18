# Fast2SMS DLT implementation

Implemented Fast2SMS as the default selectable SMS provider while preserving Twilio and SES.

## Behavior

- `FAST2SMS_MOCK_MODE` defaults to `true`; mock sends make zero network requests and return `simulated`.
- Live sends use `POST https://www.fast2sms.com/dev/bulkV2` with the DLT route, sender ID, template ID, ordered pipe-separated values, recipient number, and `sms_details: "1"`.
- A live response is accepted only when HTTP succeeds, `return === true`, and `request_id` is present.
- HTTP 408/429/5xx and timeouts are retryable. Provider acceptance is recorded as acceptance, not handset delivery confirmation.
- Indian mobile numbers are normalized to ten-digit numbers beginning 6–9.
- SMS campaigns require `dltVariableMapping`, an ordered list of variables present in the published template. Every mapped value must be a non-empty string.
- Simulated results are not marked delivered; the worker records them as a non-delivery failure outcome.

## Configuration

Added backend-only SAM parameters/environment variables:

- `FAST2SMS_API_KEY` (`NoEcho`)
- `FAST2SMS_SENDER_ID`
- `FAST2SMS_TEMPLATE_ID`
- `FAST2SMS_MOCK_MODE` (default `true`)
- `FAST2SMS_TIMEOUT_MS` (default `8000`)
- `SMS_PROVIDER` (`fast2sms` by default, `twilio` remains supported)

No real sender ID, template ID, or API key is included.

## Retry caveat

If Fast2SMS accepts a request but the worker times out before persisting recipient success, SQS may retry and duplicate delivery may occur. Existing claim/retry behavior remains in place; exactly-once handset delivery is not claimed because Fast2SMS provider acceptance is not an idempotency guarantee.

## Validation

- `npm.cmd test`: 76 passed.
- `npm.cmd run typecheck`: passed.
- `node --check apps/api/src/providers/fast2sms-provider.js`: passed.
- `sam build --template-file infra/template.yaml`: succeeded.

No deployment or real SMS request was made.

## Deployment

Keep mock mode enabled for the first deployment. Supply approved values through the deployment/secret-management workflow:

```powershell
sam build --template-file infra/template.yaml
sam deploy --config-env default --parameter-overrides SmsProvider=fast2sms Fast2SmsMockMode=true Fast2SmsSenderId=<approved-sender-id> Fast2SmsTemplateId=<approved-template-id> Fast2SmsTimeoutMs=8000
```

Only after a separate explicit approval should `Fast2SmsMockMode=false` be deployed with the API key stored through the project’s secret-management process. Test with one authorized recipient and monitor worker logs without logging credentials.
