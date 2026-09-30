---
"@hot-updater/server": minor
"@hot-updater/cli-tools": minor
"hot-updater": minor
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/supabase": minor
---

The plugin that provides `clientAuth` describes the credential an app sends in `cli.clientCredential`: its label, header, environment variable, and how to generate and provision it. `@hot-updater/server/db` exports `clientAuthOf`, `generateClientCredential`, and `provisionClientCredential`, which read it from a plugin list.

Managed init provisions the app's credential through the provider's plugins and prints `HotUpdater.init` with that credential's header, or with no `requestHeaders` when client routes are public; `@hot-updater/cli-tools` exports `renderAppSetup` and `printAppSetup` for it. AWS CloudFront cache and origin-request policies key on the client-route policy's `varyHeaders` instead of a fixed `x-api-key`.

Agent and infrastructure scaffolds record the server's `clientAuth` in `manifest.json` and render their instructions from it. The helper is `app/provision-client-credential.mjs` with `app/database.config.ts`, and it saves `app/client-credential.local`. `hot-updater doctor` reads the credential's header and variable from the scaffold, and skips the 401 check when client routes are public.
