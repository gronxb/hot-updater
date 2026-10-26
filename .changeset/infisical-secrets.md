---
"hot-updater": minor
"@hot-updater/cli-tools": minor
---

Add `infisical()` to `hot-updater`: the CLI reads and stores its secrets in an Infisical project, on Infisical Cloud or a self-hosted instance, signed in with Universal Auth, GitHub Actions OIDC, or an `infisical login` access token. `secretEnv` refuses the `INFISICAL_*` variables the adapter signs in with.
