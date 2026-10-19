# Notification MVP

## Campaign delivery

Bulk campaigns can be created immediately or scheduled from the dashboard. Immediate campaigns are stored as `queued` and enqueue work on the delivery SQS queue immediately. Scheduled campaigns include an ISO 8601 `scheduledAt` timestamp, are stored as `scheduled`, and appear in the campaign list with the browser's local start time.

When a scheduled campaign is created, the Campaign Lambda creates a one-time Amazon EventBridge Scheduler schedule. The schedule invokes `StartCampaignFunction`, which re-reads the DynamoDB campaign and atomically changes `scheduled` to `queued` before sending the existing campaign message to SQS. The existing worker then performs recipient claiming, provider delivery, retries, counters, and completion. Scheduler schedules delete themselves after completion.

The start handler is safe to retry: cancelled, paused, already-started, and not-yet-due campaigns are ignored, and the conditional state update prevents duplicate delivery work. A schedule creation failure marks the campaign `failed` so it cannot be accidentally delivered without a schedule. Cancelling a scheduled campaign prevents a stale scheduler invocation from starting it.

### AWS resources and permissions

The SAM template provisions:

- `CampaignSchedulerRole`, trusted by `scheduler.amazonaws.com`, with permission to invoke `StartCampaignFunction`.
- `StartCampaignFunction`, with DynamoDB read/update and SQS send permissions.
- Additional Campaign Lambda permissions to create schedules and pass the scheduler role.

EventBridge Scheduler is a managed AWS service and may incur schedule invocation charges. Deploy the updated SAM stack before using scheduled campaigns:

```powershell
pnpm install
sam validate --template-file infra/template.yaml
pnpm build
sam deploy --template-file .aws-sam/build/template.yaml --config-file samconfig.toml --config-env default
```

Always deploy the built template. Deploying `infra/template.yaml` directly from a pnpm workspace can omit transitive AWS SDK packages from Lambda artifacts and cause `Runtime.ImportModuleError` failures.

Do not deploy to production without reviewing parameter overrides and IAM changes.

### Testing

Run the unit suite and syntax checks with:

```powershell
pnpm test
pnpm typecheck
```

The automated tests cover immediate campaign compatibility, timestamp validation, the dashboard scheduling payload helper, recipient initialization, and the existing worker delivery behavior. Live EventBridge Scheduler invocation and provider delivery require an AWS deployment and are not exercised by unit tests.

Scheduling is currently one-time only. Recurring schedules, timezone recurrence rules, and editing a campaign after creation are intentionally out of scope.
