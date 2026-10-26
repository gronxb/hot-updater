---
"hot-updater": minor
"@hot-updater/cli-tools": minor
"@hot-updater/plugin-core": minor
"@hot-updater/apple-helper": minor
"@hot-updater/android-helper": minor
---

The CLI reads secrets through a `secrets` adapter in `hot-updater.config.ts`, `env()` from `hot-updater/secrets` by default. `SecretsAdapter` in `@hot-updater/plugin-core` is the contract: `get(names, { cwd })` reads names in one call, `undefined` for a name the store does not hold and a thrown error for any other failure, and the optional `set(name, value, { cwd })` and `describe(name)` store a value and say where it is.

- Native build `signing.keystore` and `signing.ascApiKey` name a secret as `secret:<name>`, such as `"secret:release-keystore"`. A credential is one JSON value per name: `{"keyId","issuerId","p8"}` for an App Store Connect key, `{"keystore","storePassword","keyAlias","keyPassword"}` with the keystore in base64, and a Play service account's own JSON. The `HOT_UPDATER_ASC_KEY*`, `HOT_UPDATER_ANDROID_KEYSTORE_*`, and `HOT_UPDATER_PLAY_SERVICE_ACCOUNT_*` variables still override each kind. Items a build asks for together are read in one `get`, file values are 0600 temporary files, and each value is masked in the CLI's output with every secret field of it; IDs, the key alias, and a service account's email stay readable.
- `env()` reads a name from its environment variable, in `process.env` or `.env.hotupdater`: a variable name as it is, such as `CLOUDFLARE_API_TOKEN`, and another name upper-cased after `HOT_UPDATER_`, such as `HOT_UPDATER_ASC_API_KEY` for `asc-api-key`. It is read-only.
- `secretEnv([...names])` from `hot-updater` returns a function a config's adapters call for their deploy credentials: names set in the environment win, the others come from the `secrets` adapter, and the values go only to the caller, never into `process.env`. It refuses variables that change how a process loads code, such as `NODE_OPTIONS`, `PATH`, `LD_*`, `DYLD_*`, `GIT_*`, `npm_config_*`, and the JVM's, Gradle's, Ruby's, Python's, and Perl's options, and those Hot Updater reads its credentials from (`isReservedVariableName` in `@hot-updater/cli-tools`).
- `hot-updater secrets put <name> --kind <asc-api-key|android-keystore|play-service-account>` stores a credential you have, from its files, as that JSON value through the adapter's `set`. `hot-updater secrets issue <asc-api-key|play-service-account> [name]` instead signs in with your Apple Account or Google and stores the key Hot Updater issues the same way. A sign-in never starts in CI or without a terminal, and a key the adapter surely did not store is revoked again.
