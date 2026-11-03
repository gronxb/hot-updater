---
"hot-updater": patch
"@hot-updater/cli-tools": patch
---

Add `hot-updater secrets pull [--out .env.hotupdater] [--only a,b] [--force]`, the mirror of `secrets import`: it writes the deploy credentials a team `secrets` adapter holds to a local env file for development and local builds.

- A store is read by name, so it pulls what the config's adapters read with `secret()` and `HOT_UPDATER_API_KEY`, or exactly the names `--only` lists. App runtime env is out of scope.
- Build credentials (App Store Connect API key, Play service account, upload keystore, bundle signing key) are skipped and named, and never read: builds read them from the store, so a copy would only be a private key on disk.
- The file ends up 0600 and is merged, keeping other lines and comments. A name the file holds with another value is asked about at a terminal, and refused without one unless `--force`. It warns when git doesn't ignore the file, and never prints values.
- With `localSecrets()` there is nothing to pull: it says so and exits 0.
