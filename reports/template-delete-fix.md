# Template deletion fix

## Confirmed cause

The deployed DELETE request reached the correct API route and handler. CloudWatch reported:

```text
AccessDeniedException: ... is not authorized to perform: dynamodb:DeleteItem
```

The Dashboard Lambda policy allowed `GetItem`, `PutItem`, `UpdateItem`, `Query`, and `TransactWriteItems`, but not `DeleteItem`. The handler deletes the project-scoped `TEMPLATE#<slug>#CURRENT` pointer with a condition, so DynamoDB rejected the operation before any record was removed.

## Fix

Added only `dynamodb:DeleteItem` to the DashboardFunction policy on the existing NotificationTable ARN. Project authorization, slug validation, current-template lookup, conditional deletion, and version-history retention are unchanged.

The frontend already sends:

```text
DELETE /v1/projects/{projectId}/templates/{templateSlug}
```

and refreshes the list only after a successful response. Failed deletion leaves the template visible and reports the backend error.

## Validation

Run:

```powershell
npm.cmd test
npm.cmd run typecheck
node --check apps/dashboard/app.js
sam build --template-file infra/template.yaml
```

No production template was deleted during diagnosis.

## Deployment

After validation, deploy the backend:

```powershell
sam deploy --config-env default
```

Then verify using a disposable, uniquely named template: create it, delete it from the deployed dashboard, confirm the DELETE response succeeds, refresh Templates, and confirm it remains absent. Do not use the existing `welcome` template for the first production test.
