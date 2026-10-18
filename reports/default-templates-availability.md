# Default template availability

## Root cause

The dashboard already contained the three defaults only in its demo `MOCK_DATA`. Demo Data OFF loaded DynamoDB, but project creation and template listing did not seed missing defaults, so new or existing projects could show an empty list after refresh.

## Fix

- Added shared backend default definitions with the existing subjects, HTML, text, variables, published state, and version 1 metadata.
- Added idempotent `ensureDefaultTemplates(projectId)` using the existing versioned record plus `#CURRENT` pointer transaction model.
- New projects seed defaults after their project transaction completes.
- Existing projects are lazily backfilled when their authorized templates are listed.
- Existing matching slugs are never overwritten, including custom content, draft state, or later versions.
- Demo mode continues to display the existing three mock defaults; live mode remains backend-only and does not fall back to mocks on failure.

## Validation

```powershell
npm.cmd test
npm.cmd run typecheck
sam build --template-file infra/template.yaml
```

No deployment or destructive data operation was performed.

## Existing-project migration

No manual migration is required. Visit the authorized Templates page or call the authorized list endpoint once per project to trigger lazy, idempotent backfill.
