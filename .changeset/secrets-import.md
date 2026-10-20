---
"hot-updater": minor
"@hot-updater/cli-tools": minor
"@hot-updater/supabase": minor
---

`hot-updater secrets import [file]` moves an env file's variables, `.env.hotupdater` by default, into the Console's vault as one `deploy-credentials` secret (`deploy-credentials` unless `--name` names another), then removes them from the file. Only `HOT_UPDATER_CONSOLE_URL` and `HOT_UPDATER_VAULT_TOKEN` stay, with init's `HOT_UPDATER_INIT_BUILD` and `HOT_UPDATER_INIT_PROVIDER`, the client `HOT_UPDATER_API_KEY` that ships in the app, and a `HOT_UPDATER_VAULT_MASTER_KEY`, which never goes into the vault. It asks first (`-y` skips), warns when the new version drops variables the secret set, and refuses a variable another secret sets. While the two connection variables are set, in the environment or `.env.hotupdater`, each command that loads `hot-updater.config.ts` first sets the variables of the `deploy-credentials` secrets the vault token reaches in `process.env`, a variable set locally winning, so configs that read `process.env` deploy with only those two variables. `secrets list`, `put`, and `env` also read the connection from `.env.hotupdater`. In `@hot-updater/cli-tools`, `resolveVaultVariables`, `vaultSecretVariables`, and `loadVaultDeployCredentials` are exported, and `readHotUpdaterEnv` is removed: read `.env.hotupdater` with `readHotUpdaterInitEnv(cwd).managedEnv`.
