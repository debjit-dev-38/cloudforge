# Template management implementation report

## Scope

Message templates now support project-scoped view, edit, and delete actions while preserving the existing Cognito, Lambda, API Gateway, and DynamoDB architecture.

## Backend behavior

- `PUT /v1/projects/{projectId}/templates/{templateSlug}` requires the existing project authorization check and an `expectedVersion`.
- An edit writes a new versioned record and updates the `#CURRENT` pointer in one DynamoDB transaction. Slugs remain immutable; the next version is published or drafted according to the submitted state.
- `DELETE /v1/projects/{projectId}/templates/{templateSlug}` requires project authorization and removes the current pointer. Immutable version records are retained so historical or already-queued deliveries can still resolve their recorded version.
- Missing templates return `TEMPLATE_NOT_FOUND`; stale edits return `TEMPLATE_VERSION_CONFLICT`; invalid fields return `INVALID_REQUEST`.
- API Gateway routes were added for PUT and DELETE, both protected by the existing Cognito authorizer.

## Dashboard behavior

- Every template card exposes View, Edit, and Delete actions.
- Edit is prefilled and sends a version-checked backend update. A draft is reported as a draft, never as published.
- Delete asks for confirmation and removes the card only after a successful backend response.
- Demo Data ON displays mock templates and disables mutating actions. Demo Data OFF loads persisted templates and never substitutes mocks after a failed request.

## Validation

The repository checks to run after this change are:

```powershell
npm.cmd test
npm.cmd run typecheck
sam validate --template-file infra/template.yaml
sam build --template-file infra/template.yaml
```

No AWS or Vercel deployment was performed for this change.

## Limitations

- Slug renaming is intentionally not supported; edit the content and state of the existing slug.
- Delete hides the template from current listings but retains version history by design.
- A frontend deployment still requires the project’s configured Vercel deployment workflow.
