# Template delete/recreate fix

## Root cause

The dashboard DELETE handler deleted only `TEMPLATE#<slug>#CURRENT`. It left every `TEMPLATE#<slug>#V<version>` item in DynamoDB. Recreating the slug then failed because the initial version write was correctly protected by `attribute_not_exists(PK)`.

## Fix

The API now queries all version records for the project and slug, then deletes those records and the current pointer in one DynamoDB transaction. Orphan pointers are also cleaned when version records remain. Creation retains conditional writes and returns HTTP 409 with `TEMPLATE_SLUG_EXISTS` for an existing slug; unrelated DynamoDB errors still propagate to the normal error handler.

The dashboard displays the specific conflict message instead of the generic conflict text.

## Modified files

- `apps/api/src/store.js` — added paginated version-record lookup.
- `apps/api/src/dashboard-api.js` — atomically deletes all versions and pointer; distinguishes slug conflicts.
- `apps/dashboard/app.js` — shows the actionable slug-conflict message.
- `tests/unit/template-persistence.test.js` — regression assertions for cleanup and conflict handling.

## Validation

Run from the repository root:

```powershell
npm.cmd test
npm.cmd run typecheck
sam validate --template-file infra/template.yaml
sam build --template-file infra/template.yaml
```

No AWS deployment or production data mutation was performed.

## Deployment

After reviewing the build, deploy the backend with the existing stack/configuration:

```powershell
sam deploy --template-file .aws-sam/build/template.yaml --config-env default
```

If the dashboard is served by Vercel and its frontend bundle changed, deploy the dashboard using the existing Vercel project configuration. Verify with a disposable non-default slug: create, delete, recreate, and confirm the slug conflict is returned while the original exists.
