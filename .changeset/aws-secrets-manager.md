---
"hot-updater": minor
---

`awsSecretsManager({ region, prefix?, credentials?, endpoint? })` from `hot-updater/secrets` reads the config's secrets from AWS Secrets Manager, each name as the secret `<prefix><name>`, and stores issued keys there. Requests are SigV4-signed over `fetch`, so CI needs no AWS SDK: it signs with `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN`, as GitHub Actions OIDC through `aws-actions/configure-aws-credentials` sets them, and otherwise with the AWS SDK's default chain (profiles, AWS SSO) from the optional `@aws-sdk/credential-providers` package.

- `get` reads each name with `GetSecretValue`; a secret that does not exist reads as missing, and a permission, credential, or deletion error fails with the permission it needs.
- `set` puts a new version with `PutSecretValue`, and creates a missing secret with `CreateSecret`. AWS keeps the `AWSCURRENT` and `AWSPREVIOUS` versions and removes older ones itself; the adapter deletes nothing.
- Requests use HTTPS and never follow a redirect, and the credentials the adapter signs with are masked in the CLI's output.
