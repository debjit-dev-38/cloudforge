# Campaign Duplicate Rows Diagnostic

## Executive summary

The duplicate rows are caused by the backend campaign list query, not by Demo Data or frontend concatenation.

`listCampaigns()` queried every sort key beginning with `CAMPAIGN#`. That includes both the canonical campaign item and its recipient child items:

```text
CAMPAIGN#<campaignId>
CAMPAIGN#<campaignId>#RECIPIENT#<hash>
```

Recipient child items contain `campaignId` and recipient delivery fields, but do not contain campaign fields such as `state`, `templateSlug`, `total`, or `createdAt`. The API returned those child items as if they were campaigns, and the dashboard rendered them directly. For a campaign with two recipients, this explains two malformed rows plus one valid parent row.

The fix adds a DynamoDB filter for parent campaign items, paginates past filtered child records, and makes progress rendering safe when optional counters are absent.

The backend fix has now been deployed to the `notification-mvp` stack in `ap-south-1`. Production dashboard verification remains pending because the Vercel frontend was not deployed and no production API key was used for read-only API verification. No production records were mutated or deleted.

## Observed symptoms

The reported production symptom was three rows sharing one campaign ID:

- Two malformed rows with unavailable name/status/date and `0% (undefined/undefined)`.
- One valid completed campaign with two recipients and 100% progress.

The malformed fields match recipient child records: they have `campaignId`, `projectId`, `recipient`, and recipient `status`, but not the parent campaign fields consumed by the table.

## Architecture and data flow

1. Campaign creation writes one parent campaign item and recipient child items through `createCampaign()` in `apps/api/src/store.js`.
2. The parent uses `SK = CAMPAIGN#<id>`.
3. Each recipient uses `SK = CAMPAIGN#<id>#RECIPIENT#<sha256>`, also under `PK = PROJECT#<projectId>`.
4. `GET /v1/campaigns` is handled by `apps/api/src/campaign-api.js`.
5. The handler calls `listCampaigns(apiKey.projectId)` and returns `result.Items`.
6. The dashboard calls `/v1/campaigns`, assigns `data.items` to `campaignsData`, and renders every item in `renderCampaignsTable()`.

Relevant locations:

- [apps/api/src/store.js](../apps/api/src/store.js), `createCampaign()` and `listCampaigns()`.
- [apps/api/src/campaign-api.js](../apps/api/src/campaign-api.js), campaign GET handler.
- [apps/dashboard/app.js](../apps/dashboard/app.js), `loadCampaigns()` and `renderCampaignsTable()`.

## Evidence collected

### Persistence shape

`createCampaign()` writes the parent campaign item first, then recipient items:

```js
SK: key.campaign(campaign.campaignId)
SK: key.campaignRecipient(campaign.campaignId, recipient)
```

`key.campaignRecipient()` expands to a `CAMPAIGN#<id>#RECIPIENT#...` sort key.

### Original retrieval behavior

The original query used:

```js
KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)'
ExpressionAttributeValues: { ':prefix': 'CAMPAIGN#' }
```

That prefix matches both parent and recipient records. The API then returned all matching items without filtering by record type.

### Frontend behavior

`loadCampaigns()` directly assigned the API items:

```js
campaignsData = data.items || [];
renderCampaignsTable();
```

`renderCampaignsTable()` mapped every entry. There was no second campaign endpoint, no notification-history merge, and no append behavior on refresh. Demo OFF also calls the API path rather than injecting demo campaigns.

### Why `undefined/undefined` appeared

The original `progressHtml()` interpolated:

```js
${campaign.processed}/${campaign.total}
```

Recipient child records do not have those fields. The updated renderer uses numeric zero values when counters are missing, while the backend fix prevents those child records from entering the campaign list.

## Root-cause analysis

### Confirmed root cause

The backend list query returned recipient child records as campaign rows.

This is confirmed by the key layout and the query prefix. It explains all reported symptoms without requiring duplicate parent records or frontend state duplication.

### Not the root cause

- Demo data: Demo OFF uses the API request path in `loadCampaigns()`.
- Refresh append: refresh replaces `campaignsData`; it does not append.
- Multiple endpoints: the campaign table uses one `/v1/campaigns` request.
- Duplicate canonical campaigns: the malformed rows share the parent `campaignId` because child records store that field.

### Production runtime limitation

The actual production API response and DynamoDB records were not queried during this run, so the report does not claim independent production verification. The code and data model provide a direct, confirmed explanation for the observed shape.

## Contributing factors

1. Parent and child records share the same partition and a common `CAMPAIGN#` prefix.
2. The list query did not distinguish record types.
3. The API response had no schema validation before frontend rendering.
4. The frontend progress formatter assumed counters were present.

## Implemented changes

- `apps/api/src/store.js`
  - Added `attribute_not_exists(recipient)` to campaign listing so recipient children are excluded.
  - Added pagination so filtered child records do not prevent later parent campaigns from being returned.
- `apps/dashboard/app.js`
  - Prevented missing counters from rendering as `undefined/undefined`.
- `tests/unit/campaign-list.test.js`
  - Added regression tests for child-record exclusion and pagination past recipient-only pages.
- `reports/campaign-duplicate-rows-diagnostic.md`
  - Added this evidence report.

No database records were deleted or modified.

## Risks and backward compatibility

- Existing parent campaign records are unaffected.
- Existing recipient records remain in DynamoDB and continue to support worker processing.
- Campaign list pagination now scans additional DynamoDB pages when a page contains only filtered recipient records.
- The API's existing `{ items, nextToken }` response shape is preserved.
- The frontend progress fallback changes only malformed/missing-counter presentation; valid counters render unchanged.

## Verification results

The focused regression tests passed:

```text
2 tests passed: campaign-list.test.js
```

The complete repository verification passed:

```text
69 tests passed
npm.cmd run typecheck passed
sam validate --template-file infra/template.yaml passed
sam build --template-file infra/template.yaml passed
```

The backend deployment completed successfully with CloudFormation `UPDATE_COMPLETE`. Production dashboard verification remains pending.

## Deployment and rollback

Build and validate:

```powershell
npm.cmd test
npm.cmd run typecheck
sam validate --template-file infra/template.yaml
sam build --template-file infra/template.yaml
```

Deploy the backend using the existing stack name, region, and approved parameter values:

```powershell
sam deploy --template-file .aws-sam/build/template.yaml --stack-name notification-mvp --region ap-south-1 --resolve-s3 --s3-prefix notification-mvp --capabilities CAPABILITY_IAM --parameter-overrides SendingEmail=<verified-sender> AllowedOrigins='http://localhost:5173,https://cloudforge-dashboard.vercel.app' CognitoDomainPrefix=<existing-prefix>
```

Review the CloudFormation change set before execution. Rollback should use the CloudFormation stack's previous template/version; do not delete campaign or recipient records.

After deployment, verify with Demo Data OFF:

1. Call `GET /v1/campaigns` with an API key for the target project.
2. Confirm each returned item has a parent key shape and campaign fields.
3. Confirm the target campaign ID appears once.
4. Refresh the dashboard and confirm the count remains stable.

The dashboard bundle was not deployed in this run because the Vercel CLI was unavailable in the environment. Deploy `apps/dashboard` through the existing Vercel project before performing the browser verification.

## Remaining limitations

- Production API and dashboard verification is still pending.
- This fix does not add a separate campaign schema validator; it fixes the proven storage/query boundary issue.
- Template version updates remain outside this campaign-row fix.
