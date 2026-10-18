# Template create-flow fix

## Root cause

The New Template button was registered as:

```javascript
templateCreateButton.addEventListener('click', openTemplateModal);
```

Because DOM event listeners pass the click event as the first argument, `openTemplateModal` treated the event object as a template. That made the form enter edit mode, with `template.slug` undefined. Submission then attempted a PUT to a template named `undefined`, producing “Template not found.”

## Fix

- Added explicit `templateMode` state with `create` and `edit` values.
- New Template now calls `openTemplateModal()` through a zero-argument wrapper.
- Create mode always uses `POST /v1/projects/{projectId}/templates` and does not require an existing template.
- Edit mode requires the selected canonical slug and uses `PUT /v1/projects/{projectId}/templates/{templateSlug}` with `expectedVersion`.
- Closing the modal clears edit state and resets create mode.
- Form values remain in place when the API reports an error.

## API contracts

- Create: `POST /v1/projects/{projectId}/templates`, body `{ slug, subject, html, state }`.
- Edit: `PUT /v1/projects/{projectId}/templates/{templateSlug}`, body `{ subject, html, state, expectedVersion }`.
- Both routes use the existing Cognito authorization and project authorization checks.

## Tests

Regression coverage verifies explicit create/edit modes, POST versus PUT selection, stale-state clearing, create-without-ID behavior, and existing project/versioning protections.

Run:

```powershell
npm.cmd test
npm.cmd run typecheck
node --check apps/dashboard/app.js
sam build --template-file infra/template.yaml
```

## Deployment and verification

Backend deployment:

```powershell
sam build --template-file infra/template.yaml
sam deploy --config-env default
```

Frontend deployment requires the existing Vercel project workflow, for example:

```powershell
vercel --prod
```

Production verification is pending until the updated dashboard frontend is deployed. Verify by creating a unique template slug, confirming the success message, refreshing the Templates page, and confirming the new persisted template remains visible. Do not reuse an existing production slug during this test.
