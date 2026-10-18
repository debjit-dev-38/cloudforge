# AWS Deployment Diagnostic Report

## 1. Executive summary

- **Verified:** The current local SAM build exists at `.aws-sam/build/template.yaml` and was generated successfully on 2026-10-18 at 22:48.
- **Verified:** The built Dashboard Lambda source hashes match the current `apps/api/src/dashboard-api.js` and `apps/api/src/store.js` files.
- **Verified:** The local source and built template contain `GET /v1/projects` and `OrganizationProjectsIndex`.
- **Unknown:** The current live CloudFormation, Lambda, API Gateway, and DynamoDB state could not be queried because the AWS CLI currently reports that the `default` profile does not exist.
- **Unknown:** Whether the latest build is deployed. The historical `No changes to deploy` message cannot be independently verified in this session.

## 2. Timeline of what happened

1. **Verified from supplied history:** SAM initially failed to access `C:\Users\deyri\AppData\Roaming\AWS SAM\metadata.json`.
2. **Verified locally:** Redirecting SAM application data and npm cache allowed validation and build to complete.
3. **Verified from supplied history:** An earlier deployment attempt failed because no AWS `default` profile was available.
4. **Verified locally:** The current repository contains uncommitted multi-tenant changes and a successful local build artifact.
5. **Unknown:** The supplied history says a later authenticated deployment returned `No changes to deploy`, but AWS access is unavailable now, so the result and live resource state cannot be rechecked.

## 3. Current local Git/source/build state

### Git state

**Verified:** The working tree contains these changes:

```text
M apps/api/src/dashboard-api.js
M apps/api/src/store.js
M apps/dashboard/app.js
M apps/dashboard/index.html
M infra/template.yaml
M tests/unit/template-persistence.test.js
?? reports/legacy-ownership-audit.md
?? tests/unit/legacy-ownership-audit.test.js
?? tests/unit/organization-project-discovery.test.js
?? tools/
?? .sam-cli-home/
```

`.sam-cli-home/` is local SAM runtime state created during the metadata workaround; it is not application source.

### Build comparison

- **Verified:** `.aws-sam/build/template.yaml` exists and is 17,872 bytes.
- **Verified:** `infra/template.yaml` is 15,933 bytes.
- **Verified:** Source and built Dashboard Lambda hashes match:
  - `dashboard-api.js`: `60BC3E8DB97BBE69E865738B9E5F5793660A77C6F8C9D01859DFC6E56F93C8CA`
  - `store.js`: `418EF05FBBD168EB781DD5FCF720CF322F303B279A2F2FD66401D92C68D093EB`
- **Verified:** The built template contains `/v1/projects` routes and `OrganizationProjectsIndex`.

## 4. Current live AWS/CloudFormation state

These checks could not be completed.

**Verified limitation:**

```text
aws sts get-caller-identity --profile default
The config profile (default) could not be found
```

Therefore the following are **Unknown**:

- CloudFormation stack status and last update time.
- Stack parameters and recent stack events.
- Live Lambda function configuration and code version.
- Live API Gateway routes.
- Live table status, GSI status, schema, projection, and item formats.
- Whether the live table contains `SK=META` project records.
- Whether the live resources correspond to the current build.

## 5. Deployment status and explanation of `No changes to deploy`

- **Unknown:** The current deployment status cannot be verified without AWS credentials.
- **Likely, but unverified:** `No changes to deploy` means CloudFormation judged the submitted template and parameters equivalent to the deployed stack at that time. It does not prove that the intended source files were deployed unless the submitted build artifact was verified.
- **Verified locally:** The current build artifact does include the multi-tenant route and GSI configuration.
- **Unknown:** Whether the historical deployment used this exact artifact.

No conclusion about the live deployment should be made until the caller identity, stack template, Lambda configuration, and table description are queried with AWS access.

## 6. Multi-tenant project-discovery diagnosis

### Local implementation

- **Verified:** `GET /v1/projects` is handled in `apps/api/src/dashboard-api.js`.
- **Verified:** It derives organizations from authenticated user membership records and calls `listAuthorizedProjects`.
- **Verified:** `listAuthorizedProjects` queries `OrganizationProjectsIndex` by `organizationId`, filters `SK = META`, deduplicates project IDs, and returns safe project metadata.
- **Verified:** Project creation writes:

```text
PK = PROJECT#<projectId>
SK = META
projectId = <string>
organizationId = <string>
name
ownerUserId
createdAt
```

- **Verified:** The SAM template defines `OrganizationProjectsIndex` with:

```text
organizationId: HASH
projectId: RANGE
Projection: INCLUDE(name, ownerUserId, createdAt)
```

- **Verified:** Dashboard project selection logic is present in `apps/dashboard/app.js` and `apps/dashboard/index.html`.

### Agreement and remaining uncertainty

- **Verified locally:** Frontend, API, SAM template, and build artifact agree on the endpoint and index names.
- **Unknown live data:** The deployed table’s actual project records and attributes cannot currently be verified.
- **Unknown live behavior:** Cross-tenant authorization and project discovery cannot be tested without a valid authenticated AWS/API environment.

## 7. Frontend/Vercel deployment status

- **Unknown:** Vercel deployment status was not queried.
- **Verified locally:** Dashboard source changes exist in `apps/dashboard/app.js` and `apps/dashboard/index.html`.
- **Unknown:** Whether those changes are present at `https://cloudforge-dashboard.vercel.app`.

## 8. Risks and uncertainties

- **High:** AWS profile absence prevents verification of the production stack and prevents safe deployment-state claims.
- **Medium:** The working tree contains uncommitted and untracked changes; an unrelated change could be included in a future build unless reviewed before deployment.
- **Medium:** A successful SAM build does not prove that the corresponding artifact reached Lambda.
- **Medium:** The GSI may be active while containing no qualifying records; live table contents must be checked before diagnosing project discovery.
- **Low:** The local build source hashes match the current API source, reducing the risk of a stale local build.

## 9. Recommended next steps, ordered by priority

1. Authenticate the AWS CLI locally with the intended account and verify it without exposing credentials:

   ```powershell
   aws sts get-caller-identity --profile default
   ```

2. Query the stack, Lambda resources, API routes, table, GSI, and representative records using read-only commands.
3. Compare the live CloudFormation template and Lambda code/configuration with `.aws-sam/build/template.yaml`.
4. Review the complete Git diff and remove unrelated changes before any deployment.
5. If deployment is needed, create and review a CloudFormation changeset; reject any table/GSI replacement or destructive action.
6. Verify `GET /v1/projects` with a valid Cognito token and confirm the response is project-authorized.
7. Separately verify whether a Vercel deployment is required for the dashboard changes.

## 10. Evidence table

| Command/evidence | Result | Conclusion |
|---|---|---|
| `git status --short` | Six tracked files modified plus untracked audit/tests/tools and `.sam-cli-home` | **Verified:** local changes are uncommitted |
| `Get-Item .aws-sam/build/template.yaml` | File exists, 17,872 bytes | **Verified:** build artifact exists |
| `rg` on built template | `/v1/projects` and `OrganizationProjectsIndex` found | **Verified:** intended features are in the build |
| `Get-FileHash` source vs built API files | Matching hashes for `dashboard-api.js` and `store.js` | **Verified:** API build is not stale relative to source |
| `Get-Content samconfig.toml` | Stack `notification-mvp`, region `ap-south-1`, profile `default` | **Verified:** intended local deployment configuration |
| `aws sts get-caller-identity --profile default` | `The config profile (default) could not be found` | **Verified:** live AWS investigation is currently blocked |
| Live CloudFormation/DynamoDB/Lambda/API queries | Not executed successfully due missing profile | **Unknown:** current production state |
| Vercel deployment query | Not performed | **Unknown:** current dashboard deployment state |

### Terminal summary

The current local build is successful and contains the multi-tenant project-discovery changes. The live AWS deployment state is not verifiable because the `default` AWS profile is absent in the current session. No AWS resources or production data were modified.
