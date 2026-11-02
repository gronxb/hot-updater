---
"hot-updater": minor
---

`infisical()` needs only `projectId`: `secrets: infisical({ projectId: "…" })`. `environment` defaults to `"prod"` and `path` to `"/"`. Without `siteUrl`, it reads the instance from `INFISICAL_DOMAIN`, then `INFISICAL_API_URL`, as the Infisical CLI does, before Infisical Cloud's US region. The `auth` option is removed: it signs in only from the environment or `.env.hotupdater`, with `INFISICAL_TOKEN`, Universal Auth, or GitHub Actions OIDC with `INFISICAL_MACHINE_IDENTITY_ID`, requesting the ID token with GitHub's default audience. Without any of them, it says in two lines which variables to set and links the guide.
