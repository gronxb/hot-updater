# AWS environment

Read COMMON.md for secure credential handling. Discover the authenticated account,
region and existing deployment. Create missing S3, DynamoDB, IAM, Lambda@Edge and
CloudFront resources as required by SETUP.md. Record returned IDs and ARNs instead
of asking the user to prepare every resource first.

The supplied app config uses `fromNodeProviderChain()`. Prefer an existing role,
session, shared profile or SSO login. Set only applicable values in the app's
ignored .env.hotupdater; never copy the complete example with empty optional
credential values into an otherwise working credential environment.

| Variable | Purpose and when needed | Where to obtain it |
| --- | --- | --- |
| `HOT_UPDATER_DYNAMODB_TABLE_NAME` | Required by the local metadata plugin and client-key helper. | Query/create the table specified in SETUP.md and record its verified name. |
| `HOT_UPDATER_S3_BUCKET_NAME` | Required by local storage and Lambda deployment inputs. | Query/create the selected S3 bucket and record its name. |
| `HOT_UPDATER_S3_REGION` | Required by the supplied local config, which uses the selected regional AWS resources. Lambda@Edge publication separately uses us-east-1. | Read the bucket's actual region and use the matching regional deployment inputs in SETUP.md. |
| `HOT_UPDATER_AWS_LAMBDA_NAME` | Lambda deployment identity and signing-parameter path input; recorded for init reuse. | Derive a project-based name for a new installation, check conflicts, or preserve the existing verified function name. |
| `HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID` | Required for cache invalidation after deployment; leave unset during initial key registration before the distribution exists. | Query/create the distribution and record its ID, not its domain name. |
| `HOT_UPDATER_API_KEY` | Client authentication via `x-api-key`; required after the table is ready. | Reuse the existing client key or run app/provision-api-key.mjs; persist the same key across retries. |
| `HOT_UPDATER_AWS_AUTH_MODE` | Interactive-init choice only: local-session, shared-profile, sso, or account. The supplied scaffold config does not read this selector. | Record the init choice only when needed; configure the standard credential chain below for this scaffold. |
| `HOT_UPDATER_AWS_PROFILE` | Interactive-init profile selection; not read by the supplied config. | For the scaffold's credential chain, select an existing profile with `AWS_PROFILE` instead. |
| `HOT_UPDATER_S3_ACCESS_KEY_ID` | Optional account/access-key mode input for interactive init; not read by the supplied config. | Prefer role/profile/SSO access. If explicitly using access keys with this scaffold, configure standard AWS credentials below, not this variable. |
| `HOT_UPDATER_S3_SECRET_ACCESS_KEY` | Secret paired with the interactive-init account/access-key input; not read by the supplied config. | Reuse secure local credentials; do not create permanent keys merely because this field appears in env.example. |

## Standard AWS credentials

The SDK reads these settings through its default credential chain; they are not
mandatory template fields. Leave unused alternatives unset.

- `AWS_PROFILE`: an existing shared-config or SSO profile name. Authenticate with
  the provider's CLI/session flow when needed; do not ask for SSO tokens in chat.
- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`: only when using environment
  credentials instead of a profile/role. Save them through private local tooling.
- `AWS_SESSION_TOKEN`: required together with temporary environment credentials.
  Obtain and refresh it with the session, not by generating a long-lived key.

An MCP session might not be usable by the local AWS SDK. Verify the local caller
identity separately without logging credential material.

## Runtime and signing inputs

Lambda@Edge receives its resource settings through placeholders in the bundled
code, not ordinary Lambda environment variables. Follow SETUP.md for the role,
qualified Lambda ARN, CloudFront key/group IDs and the regional SSM signing pair.
Persist new signing material privately before remote registration and reuse it.
The manifest/deployment record holds resource identifiers, never private keys.
