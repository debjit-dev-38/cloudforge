# Legacy ownership audit

The audit is read-only and never runs in a Lambda authorization path. Run it with:

```powershell
node tools/legacy-ownership-audit.mjs <DynamoDB-table-name>
```

It scans only projected ownership fields (`PK`, `SK`, `projectId`, `organizationId`, `ownerUserId`, `userId`, and project name) and emits counts plus reviewable evidence. It never returns API-key material, hashes, secrets, or recipient data.

Classification:

- `unambiguous_match`: one project metadata record has the legacy membership's organization ID.
- `ambiguous_match`: multiple project metadata records share that organization ID.
- `no_match`: no project metadata record has the organization ID.
- `invalid_or_inconsistent`: required membership fields are malformed, or the user owns a project in a conflicting organization.

The existing authorization model treats organization membership as access to projects in that organization, but a legacy membership cannot safely receive one `projectId` when multiple projects exist. No migration is implemented.

Recommended migration: review only `unambiguous_match` rows, then run an idempotent, conditional update that adds `projectId` only after approval. Leave ambiguous, no-match, and inconsistent rows unchanged. Re-run the audit before and after migration and keep a rollback/export record.
