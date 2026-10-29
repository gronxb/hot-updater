---
"hot-updater": minor
"@hot-updater/cli-tools": minor
---

Add `infisical()`, a built-in secrets adapter exported from `hot-updater` beside `localSecrets()`: the CLI reads and stores its secrets in an Infisical project, on Infisical Cloud (`https://us.infisical.com` by default, `https://eu.infisical.com` for EU) or a self-hosted instance, whatever provider you deploy to. It calls Infisical's REST API with `fetch` and installs nothing.

```ts
secrets: infisical({ projectId: "…" }),
```

- It signs in with `INFISICAL_TOKEN` (such as `infisical user get token --plain`), a machine identity's Universal Auth (`INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` and `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET`), or GitHub Actions OIDC (`INFISICAL_MACHINE_IDENTITY_ID` with `id-token: write`), from the environment or `.env.hotupdater`. `secretEnv` refuses `INFISICAL_*` names.
- `get` lists the folder, its imports included, and reads each name it holds as stored; a missing name reads as `undefined`, and a wrong project, environment, or folder fails with Infisical's reason. `set` updates the secret, or creates it.
- `set` refuses a value Infisical would trim, which would not read back as stored, and a request over Infisical's 1 MiB limit. Values, tokens, and client secrets are masked in the CLI's output.
- The Infisical docs snippet is gone: the guide now covers the built-in adapter, with project and machine identity setup, local sign-in, CI with GitHub OIDC or Universal Auth, and self-hosted instances.
