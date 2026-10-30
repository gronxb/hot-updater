# @hot-updater/cli-tools

## 1.2.0-rc.11

### Patch Changes

- 4c10736: Warn on a missing secret nothing reads, close every doctor run with its counts, and keep Infisical errors within 76 columns.
  - A `secret()` that is missing and that no build reads, such as a debug variant's keystore or a simulator scheme's App Store Connect API key, is now a warning: the Secrets block is marked `▲`, the run still passes with exit code 0, and `--json` lists it as a `SECRETS_MISSING_UNUSED` warning in `details.secrets.issues`. A missing name an adapter's `secret()` reads is a `DEPLOY_SECRETS_MISSING` warning in `details.deploySecrets.issues`.
  - Doctor's last line counts what it found. A run with warnings ends `All checks passed with 2 warnings.`, and a failing run, the `--scope` checks included, now ends `Doctor found 1 error, 2 warnings.` before it exits with code 1.
  - Messages the CLI breaks into lines, such as a secrets adapter's errors, now fit 76 display columns with clack's `│  ` in front, measured as a terminal shows them rather than by length. `infisical()` cuts Infisical's own message to fit, and names the project on one line and the environment and folder on the next. A URL that can't fit stays alone on its line.

- @hot-updater/protocol@1.2.0-rc.11
  - @hot-updater/server@1.2.0-rc.11
  - @hot-updater/plugin-core@1.2.0-rc.11

## 1.2.0-rc.10

### Patch Changes

- 41444fa: `native-build ios` shows CocoaPods' error when `pod install` fails: its `[!]` lines and last lines, without curl's download progress, with the path to the full log in `.hot-updater/log`.
- fd2aa7e: Fail `hot-updater doctor` on a signing secret a build needs, and keep secrets errors within 76 columns.
  - A `secret()` that a build or a deploy reads and that resolves nowhere now fails doctor: an error under the Secrets block with the command that imports the existing key, no "All checks passed", and exit code 1, for `--json` too. "Needed" is what the build resolves: an iOS device scheme's `signing.ascApiKey`, a release variant's `signing.keystore`, and `signing` while bundle signing is on. A simulator scheme, a debug variant, or `enabled: false` reads nothing, so its missing secret stays a `missing, unused` row. An adapter doctor can't read stays a warning. `--json` gives each reference `required`, and a `message` when a required one is missing.
  - The Google Play row marks a package ✗, `upload keystore missing`, when the keystore its release signs with is missing, and `--json` adds `missingKeystore` to that package.
  - Deploy prints a missing signing key's next step on a line of its own, as the error lays it out, instead of folding it into the sentence before it. Text the CLI prints that is already laid out in lines keeps them.
  - `keys export-public` prints `Public key not exported.` with its cause on the lines after it, doctor and `init` put a secrets adapter's error under `Couldn't read the <adapter> secrets adapter.`, and `infisical()`, `localSecrets()`, and `secret()` break a line that a long name, folder, path, or URL would widen past 76 columns. A URL longer than a line gets a line of its own.

- @hot-updater/protocol@1.2.0-rc.10
  - @hot-updater/server@1.2.0-rc.10
  - @hot-updater/plugin-core@1.2.0-rc.10

## 1.2.0-rc.9

### Patch Changes

- 12ff126: Catch a wrong upload-key password before it is stored, and keep secrets errors short.
  - `secrets put android-keystore` checks that the key password unlocks the key by signing an empty file with the JDK's `jarsigner`, as Gradle signs, before anything is stored. keytool's certificate request reads a PKCS12 key with the store password whatever the key password is, so a PKCS12 keystore stored with another key password, as EAS records it, used to fail the build only at its final signing step ("Given final block not properly padded"). The refusal reads `The key password doesn't unlock "<alias>".`, then `For PKCS12 keystores, the key password is the store password.` when the store password unlocks the key. At a terminal the CLI then offers to store the store password as the key password; in CI it stops, storing nothing.
  - `--key-alias`, which stored a keystore without checking it, now runs the same check, so it needs a JDK on the machine, as Android builds do.
  - `secrets issue android-keystore` names a stored keystore whose passwords don't open its key, and `--pem` still exports its certificate, and `hot-updater doctor` marks such a keystore in its Secrets block (`in the adapter, doesn't open`), with the reason and the command that stores it again. Without a JDK, doctor leaves it unchecked.
  - A `signing` secret the store doesn't hold points at importing the existing key, `npx hot-updater secrets put bundle-signing-key <key.pem>`, and at checking the name and access, never at `secrets issue`, whose new key every shipped app rejects. `secrets put android-keystore` without a file offers `secrets issue android-keystore` only for an app with no `.aab` on Play yet.
  - `infisical()`, `localSecrets()`, `secret()`, `secretsManager()`, `keyVault()`, and `secretManager()` errors print a line per idea, the reason first and the fix last, at most 76 columns: a provider's own message is wrapped or shortened on its own lines, a secret's full name gets a `Secret:` line, and long commands break with `\`.
  - `infisical()` names its instance's URL, as an `Instance:` line, only when `siteUrl`, `INFISICAL_DOMAIN`, or `INFISICAL_API_URL` sets it; with none set, messages say `Infisical`. A `siteUrl` that holds credentials is not quoted.

- @hot-updater/protocol@1.2.0-rc.9
  - @hot-updater/server@1.2.0-rc.9
  - @hot-updater/plugin-core@1.2.0-rc.9

## 1.2.0-rc.8

### Minor Changes

- 2e3f250: Add `infisical()`, a built-in secrets adapter exported from `hot-updater` beside `localSecrets()`: the CLI reads and stores its secrets in an Infisical project, on Infisical Cloud (`https://us.infisical.com` by default, `https://eu.infisical.com` for EU) or a self-hosted instance, whatever provider you deploy to. It calls Infisical's REST API with `fetch` and installs nothing.

  ```ts
  secrets: infisical({ projectId: "…" }),
  ```

  - It signs in with `INFISICAL_TOKEN` (such as `infisical user get token --plain`), a machine identity's Universal Auth (`INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` and `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET`), or GitHub Actions OIDC (`INFISICAL_MACHINE_IDENTITY_ID` with `id-token: write`), from the environment or `.env.hotupdater`. `secret()` refuses `INFISICAL_*` names.
  - `get` lists the folder, its imports included, and reads each name it holds as stored; a missing name reads as `undefined`, and a wrong project, environment, or folder fails with Infisical's reason. `set` updates the secret, or creates it.
  - `set` refuses a value Infisical would trim, which would not read back as stored, and a request over Infisical's 1 MiB limit. Values, tokens, and client secrets are masked in the CLI's output.
  - The Infisical docs snippet is gone: the guide now covers the built-in adapter, with project and machine identity setup, local sign-in, CI with GitHub OIDC or Universal Auth, and self-hosted instances.

- c463534: `secret("<name>")` from `hot-updater` names every credential in `hot-updater.config.ts`. It replaces the `"secret:<name>"` strings and `secretEnv([...])` of earlier 1.2 RCs, so configs written for those RCs break: rerun `init` for a managed config, or edit it as below.

  ```ts
  import { defineConfig, secret } from "hot-updater";

  export default defineConfig({
    storage: r2Storage({
      bucketName: "bundles",
      accountId: "…",
      credentials: {
        accessKeyId: secret("HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID"),
        secretAccessKey: secret("HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY"),
      },
    }),
    database: d1Database({
      databaseId: "…",
      accountId: "…",
      cloudflareApiToken: secret("HOT_UPDATER_CLOUDFLARE_API_TOKEN"),
    }),
    signing: { enabled: true, privateKey: secret("bundle-signing-key") },
    nativeBuild: {
      android: {
        release: { signing: { keystore: secret("release-keystore") } },
      },
      ios: { release: { signing: { ascApiKey: secret("asc-api-key") } } },
    },
  });
  ```

  - `secret()` returns a function an adapter calls on first use, so loading the config reads no secret. Called, it reads the environment or `.env.hotupdater` first, then the config's `secrets` adapter: one call reads every name of the config the environment doesn't set. With `localSecrets()`, an adapter credential must be set in the environment. Values are masked, and reserved names, such as `NODE_OPTIONS`, are refused.
  - `signing.privateKey`, `signing.keystore`, and `signing.ascApiKey` take only `secret()`: a string is a type error, and the CLI refuses it in one line.
  - Storage and database adapters take each credential as a string or a function (plugin-core's `Lazy<T>`), so servers keep passing their own environment's values. `s3Storage`, `dynamoDB`, and `r2Storage` also take access keys whose fields are lazy, and the header values of `standaloneRepository` and `standaloneStorage` may be lazy.
  - `init` writes `secret()` inline and moves an earlier RC config's `secretEnv` helpers to it. `doctor` and `secrets import` find the names in the adapters' `secret()`s.
  - `secrets put bundle-signing-key <key.pem>` moves an existing RSA key (PKCS#1 or PKCS#8, 2048 bits or more) into the secrets store as PKCS#8, reads it back, and prints its public key's SHA-256 fingerprint. A `privateKeyPath` key moves this way without a new trust anchor.

- 5358377: Bundle signing reads one secret, and the signing adapters are removed.

  ```ts
  import { defineConfig, secret } from "hot-updater";

  export default defineConfig({
    signing: secret("bundle-signing-key"),
  });
  ```

  - `signing: secret("bundle-signing-key")` is the shorthand of `{ enabled: true, privateKey: secret("bundle-signing-key") }`: the secret holds the RSA private key in PEM. 1.1's `{ enabled: true, privateKeyPath }` keeps working as it is, and `{ enabled: false }` turns signing off.
  - `npx hot-updater secrets issue bundle-signing-key` creates an RSA 4096 key, stores it as PKCS#8 through the config's `secrets` adapter, reads it back, prints its public key's SHA-256 fingerprint, and adds the shorthand to a config without `signing`. It keeps a stored key unless `--replace`, since apps already shipped reject bundles signed with a new key, and without a terminal it creates one only in a team store. `keys generate` is removed; `keys export-public` and `keys remove` read the key through `signing`.
  - Without `signing`, `deploy` warns once a run, and `doctor` shows the same warning row: `Bundles are unsigned.`, then `To sign them, run: npx hot-updater secrets issue bundle-signing-key`.
  - `awsKmsSigning`, `googleCloudKmsSigning`, and `remoteSigning`, the `hot-updater/signing` entry, plugin-core's `BundleSigningAdapter` and its remote signing protocol, and the reserved `HOT_UPDATER_SIGNING_TOKEN` are removed, with the optional `@aws-sdk/client-kms` and `@google-cloud/kms` peers. A signing adapter, or any other `signing` value, is a type error, and `deploy` refuses it, before it connects or builds, rather than deploy unsigned bundles: `signing takes secret("bundle-signing-key").`, then `Store your key: npx hot-updater secrets put bundle-signing-key <key.pem>`. `doctor` shows it as an error row.
  - `@hot-updater/cli-tools`: `prepareBundleSigning(signing, { cwd, secrets })` and `getBundleSigningPublicKey(signing, { cwd, secrets })` take the config's `signing` as it is; `readBundleSigningState(signing)` tells signing on, off, unsigned, and refused apart. `DEFAULT_SIGNING_KEY_SECRET` is `BUNDLE_SIGNING_KEY_SECRET`. `addSigningSecretToConfig(cwd, name)` adds the shorthand to `hot-updater.config.ts`.

### Patch Changes

- 8a440e3: Google Play is set up with `secrets put`, and checked before a build. `hot-updater google-play login` and its gcloud flow are removed, along with `secrets issue play-service-account`. Store the service account's JSON key with `secrets put play-service-account <key.json>`, which checks that the file is a service account key and names `google-services.json` when you pick that one by mistake. Store the app's upload keystore with `secrets put android-keystore <file>`, which asks for its passwords at a terminal and checks them with keytool. `secrets put` takes the file as its second argument and defaults the kind to the name, and every value it stores is read back exactly. `native-build android --submit play-internal` and `google-play upload` check the key, the keystore, and Play access (an edit opened and deleted) before the prebuild. They list every unmet item at once, with the command, the Play Console invite, or the first `.aab` upload that fixes it. `hot-updater doctor` adds a Google Play row with the same access check for each Android package. `secrets issue android-keystore` now says its new key fits only an app with no `.aab` on Google Play yet. The native build guide has a new "Set up Google Play" section.
- 21cfeec: `native-build ios` and `native-build android` print a few lines with live progress. One `Preparing` line covers the prebuild, the app version or fingerprint, codegen, Ruby gems, and pods, showing the current sub-step, and ends as `Prepared iOS 1.7.0 · prebuild · codegen · pods` with its duration. The cache result is one line with its reason, such as `Cache miss · engine changed`. Archive, export, and Gradle each show one live line with the phase read from the tool's output (`Compiling React-Core · 412 files`, `Linking`, `Signing`, `Bundling JavaScript`, or Gradle's current task) and the elapsed time, and each ends as one line with its duration. Registering the build and uploading it to TestFlight or Google Play are also one line each. The run ends with a summary: the artifact's path and size, the version and build number, the MIN_BUNDLE_ID, the channel, the total time, and the build log. The xcodebuild or Gradle command line, the full native build key, and what changed since the cached build go to the build log, so credential file paths stay off the terminal. iOS writes the archive and its export to one log. In CI and without a terminal, no spinner runs: each finished step prints one line. A failure ends its step's line as failed, then prints up to 20 of the tool's error lines (an export's errors with the lines that explain them), or else its last 15 lines, and the log's path on stderr. A failed `pod install`, `bundle install`, or codegen names the command and the last lines of its output. `xcbeautify` is no longer used. `expo prebuild` now reports done after it finishes, not before it starts. `@hot-updater/cli-tools` exports `startStep`, `createStep`, `withStep`, `failActiveStep`, `formatDuration`, and `withDuration`; while a step runs, `p` spinners and info lines become its detail, and other logs print after its line. `BuildLogger` takes a `createPhaseReader` instead of `importantLogPatterns` and `progressStages`.
- Updated dependencies [c463534]
- Updated dependencies [5358377]
  - @hot-updater/plugin-core@1.2.0-rc.8
  - @hot-updater/server@1.2.0-rc.8
  - @hot-updater/protocol@1.2.0-rc.8

## 1.2.0-rc.7

### Patch Changes

- f3989de: rc.6 QA fixes. A CI iOS build revokes only the signing certificates Xcode created in its keychain, never the Apple CA intermediates imported beside them, and a certificate it can't revoke is named on one line with its serial on the next, then the page to revoke it. When Apple's Program License Agreement isn't accepted, the build failure, TestFlight uploads, the certificate revocation, and key issuing say the Account Holder must accept it at developer.apple.com/account. `secrets import` takes the env file to read, `.env.hotupdater` by default, reads only that file, and lists the names it stored one per line. A secrets adapter that can't be read names the secret and the adapter above its own error. `secrets issue asc-api-key` and `apple login` name the team the key was issued in.
- @hot-updater/protocol@1.2.0-rc.7
  - @hot-updater/server@1.2.0-rc.7
  - @hot-updater/plugin-core@1.2.0-rc.7

## 1.2.0-rc.6

### Patch Changes

- @hot-updater/protocol@1.2.0-rc.6
  - @hot-updater/server@1.2.0-rc.6
  - @hot-updater/plugin-core@1.2.0-rc.6

## 1.2.0-rc.5

### Patch Changes

- dd7db4b: `secrets issue android-keystore` creates the Android upload key with the JDK's keytool and stores it through the secrets adapter, and `google-play login` sets it up after the Play service account: a new key, or the keystore you have.
- 709997a: `google-play login` signs in to Google with the gcloud CLI, running `gcloud auth login` when no account is active, and needs no Google OAuth client of your own (`HOT_UPDATER_GOOGLE_OAUTH_CLIENT_ID`/`_SECRET` are gone) and no Play Console developer account ID. The package name is filled in from the config's `nativeBuild.android` schemes (a choice when they declare several), as `native-build android --submit play-internal` does. The service account goes in the Google Cloud project "Hot Updater Play" an earlier run created, or a new one, without asking; only when Google refuses to create a project does it ask for one of the account's projects. After creating the key, it opens Play Console's invite page for the service account and waits, up to 10 minutes, until the key can reach the app; when it never does, it deletes the key and says to invite the service account and run `npx hot-updater google-play login` again.
- 5d4d977: The config managed `init` writes names the provider's resources and reads its credentials with `secretEnv`, so a team store in `secrets` shares them: `init` stores them there with `HOT_UPDATER_API_KEY` and reads a missing one back, and `secrets import` moves an existing project's from `.env.hotupdater`. Doctor lists where each `secretEnv` name comes from. The storage and database adapters take a credential as a string or a function.
- 2fd1c83: A configured `secrets` adapter is the only store: the CLI no longer reads `~/.hot-updater/secrets/` under it or writes there for it, so a teammate with the config and store access sees what you see. An issued key must read back exactly through the adapter, or it is revoked; the run uses it from memory. When the environment overrides a key the adapter lacks, `apple login` and `google-play login` add an `Adapter` row. `hot-updater doctor` lists each `secret:` reference and whether the adapter, the environment, or nothing holds it, with matching `--json` fields.
- Updated dependencies [2fd1c83]
  - @hot-updater/plugin-core@1.2.0-rc.5
  - @hot-updater/server@1.2.0-rc.5
  - @hot-updater/protocol@1.2.0-rc.5

## 1.2.0-rc.4

### Patch Changes

- @hot-updater/protocol@1.2.0-rc.4
  - @hot-updater/server@1.2.0-rc.4
  - @hot-updater/plugin-core@1.2.0-rc.4

## 1.2.0-rc.3

### Patch Changes

- 3c00e7a: The commands new in 1.2 print short output that fits an 80-column terminal: one idea per line, `Label  value` rows padded to a common width, paths with `~` or relative to the project and shortened in the middle, and bare highlighted commands without backticks. A result with nothing to do, such as `apple login` with a key already stored, states the result and stops; a next step is printed only when you have to act. `apple login` and `google-play login` name the one place they found the key. Doctor prints each issue and its resolution as one entry, a sentence per line. `--json` output is unchanged.
- @hot-updater/protocol@1.2.0-rc.3
  - @hot-updater/server@1.2.0-rc.3
  - @hot-updater/plugin-core@1.2.0-rc.3

## 1.2.0-rc.2

### Patch Changes

- @hot-updater/protocol@1.2.0-rc.2
  - @hot-updater/server@1.2.0-rc.2
  - @hot-updater/plugin-core@1.2.0-rc.2

## 1.2.0-rc.1

### Patch Changes

- @hot-updater/protocol@1.2.0-rc.1
  - @hot-updater/server@1.2.0-rc.1
  - @hot-updater/plugin-core@1.2.0-rc.1

## 1.2.0-rc.0

### Minor Changes

- 6276804: Sign in with your Apple Account to issue the App Store Connect API key. An iOS build that needs a key for `signing.ascApiKey` or `--submit testflight` and finds none asks for the Apple Account, its password (masked), and the two-factor code in Hot Updater's own prompts in a terminal, issues a team key named `hot-updater <date>` with the Admin role through asc, the open-source App Store Connect CLI, stores it through the config's `secrets` adapter, `localSecrets()` by default, which keeps it in `~/.hot-updater/secrets/<project-key>/` on this machine, and continues; `hot-updater secrets issue asc-api-key [name]`, or its shortcut `hot-updater apple login`, which takes no options or arguments, does the same ahead of time, the only command that signs in before a build. It keeps a key the adapter or the environment already provides, printing where it is and its key ID. Keys are per machine: on one without a key, it says before signing in that it will issue a new key, and how to share one key across machines instead; after issuing, it names the App Store Connect page where you revoke the keys no machine uses anymore. `--replace` issues a new key, stores it, and names the old key ID with where to revoke it in App Store Connect, never revoking it itself, since CI may still use it. `hot-updater secrets put` only imports a key you have (`--p8`, `--key-id`, `--issuer-id`) and points to `apple login` without them. Builds and `apple login` without a terminal or in CI never sign in: builds use the stored key and refuse with `npx hot-updater apple login` when there is none, or `npx hot-updater secrets issue asc-api-key <name>` for a key named otherwise. Hot Updater keeps no Apple session, so there is no logout: each sign-in ends naming the key it stored and where. Only the issued key is kept: asc's session, config, and the `.p8` live in a temporary directory that is deleted, and a key that surely was not stored is revoked again.
- d7f02a6: Native builds run in CI without signing in. The CLI treats a run as CI when `CI` is set or it has no terminal: it asks nothing there, even on a terminal a runner allocates, and never starts an Apple or Google sign-in. `native-build ios` and `native-build android` resolve every credential they sign and upload with before the build adapter's prebuild, so a missing one fails in seconds; the error names the `secrets` adapter and where it keeps the credential, the command that stores it once (`apple login` or `google-play login` for a key Hot Updater issues, `secrets put` for a keystore), and the environment variables that provide it instead. In CI, an iOS build that signs with an App Store Connect API key archives and exports in a keychain of its own, restores the runner's keychains afterwards, and revokes the development certificates Xcode created in it, so runners that start empty don't pile up certificates. The new `actions/native-build` GitHub Action runs `native-build <platform> --submit` with the job's environment, its `submit` input naming the store, and the "Build and upload from CI" guide has a complete workflow that maps GitHub Actions secrets to the job's environment. When the build fails, the action uploads the CLI's build log as the `hot-updater-build-log-<platform>-<scheme>` artifact and sets it as the `build-log` output.
- e97d063: Add `createCredentialResolver`, the CLI's credential resolver: it resolves an App Store Connect API key, an Android keystore, or a Play service account from per-item environment overrides (such as `HOT_UPDATER_ASC_KEY_PATH`, `HOT_UPDATER_ASC_KEY_ID`, and `HOT_UPDATER_ASC_ISSUER_ID`), writes file values as 0600 temporary files deleted on dispose and on exit, fails naming the environment variables that can provide a missing item, and masks every resolved secret in CLI logs and build log files.
- 0050ff3: `hot-updater doctor --fix` is removed. Doctor only reports and writes nothing, and each issue names the command or edit that resolves it in `resolution` and `commands`. The flag is gone like any unknown option, and `--json` output has no `fixes` and no `fixability`. Run instead:

  | Issue                                                                                 | Run                                                                                                                                                                                 |
  | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `SCHEMA_MIGRATION_PENDING` on a deployment `hot-updater init` created                 | `npx hot-updater init --provider <provider> --from-env-file .env.hotupdater`, which migrates the database and redeploys the server back to back                                     |
  | `SCHEMA_MIGRATION_PENDING` on a server of your own                                    | `npx hot-updater db migrate <server file>` in the server's project, or `npx hot-updater db generate <server file>` and the database's tooling for Drizzle, Prisma, D1, and Supabase |
  | `MISSING_FINGERPRINT_JSON`, `FINGERPRINT_JSON_STALE`, `FINGERPRINT_ENGINE_UNRECORDED` | `npx hot-updater fingerprint create`                                                                                                                                                |
  | `FINGERPRINT_JSON_UNUSED`                                                             | Delete `fingerprint.json`, then rebuild the apps                                                                                                                                    |
  | `MISSING_PUBLIC_KEY`, `PUBLIC_KEY_MISMATCH`                                           | `npx hot-updater keys export-public`, then rebuild and release the app; installed apps keep the previous key                                                                        |
  | `RELEASE_CATALOG_STALE`                                                               | Any release change in the scope, such as `npx hot-updater deploy` or `npx hot-updater bundle update <id>`, which recompiles its catalog                                             |
  - Doctor detects a deployment `hot-updater init` created from the provider `.env.hotupdater` records, when the config's database is the one init saved: each provider's database factory now marks the resource it reaches, without credentials, and doctor compares it with the saved inputs. A database that reaches another resource gets your own server's commands; when doctor cannot tell, it names both, each with its condition. For it, a pending schema and an outdated server (`--server-base-url`) both name init with its saved inputs: it applies the release's migrations and then redeploys the Worker, Edge Function, Lambda@Edge function with its IAM role policy, Cloud Function, Vercel Function, or Function App, so the 503 window is the deploy. An outdated server of your own names `db migrate` and `db generate`, and doctor prints the reason beside the commands.
  - While the config lists a plugin of your own, doctor does not name init: init deploys only the official plugins and writes that list back into `hot-updater.config.ts`, so it would drop the plugin. Doctor says to remove it, or to migrate as a server of your own. While the schema is `SCHEMA_NEWER_THAN_CLI`, `SCHEMA_NOT_MIGRATABLE` or `PLUGIN_SCHEMA_CHANGED`, an outdated server's remediation names no command, since an upgrade would migrate over those settings.
  - `UNREFERENCED_ARTIFACTS` and `ARTIFACTS_UNCHECKED` are no longer reported: core deletes an artifact record with the last release that uses it, so it never leaves one behind.
  - A stale release catalog only follows an edit made outside Hot Updater or a partial restore, since every release change writes its scope's catalog; doctor still reports it, as devices read the catalog.
  - `@hot-updater/cloudflare/init` and `@hot-updater/supabase/init` no longer export `migrateDatabase`, and `@hot-updater/cli-tools` no longer exports `MigrateManagedDatabase`. `d1Database` and `supabaseDatabase` mark their target under the shared `Symbol.for("@hot-updater/database-target")` instead of their own symbols.
  - The schema fence's errors, the standalone repository's 503 error, and the Console's migration notice send you to `npx hot-updater doctor`, which names the command for the database.

- 1ad0ebe: Local PEM signing reads its private key from the config's `secrets` adapter with `signing: { enabled: true, privateKey: "secret:<name>" }`, beside `privateKeyPath`. The CLI reads the secret once per run, when it first derives the public key or signs, masks it in its output, and keeps it in memory only; a missing secret fails the deploy with where it was looked for. Without an adapter, `secret:bundle-signing-key` is `HOT_UPDATER_BUNDLE_SIGNING_KEY` in the environment, where a one-line PEM with `\n` for its line breaks reads as the PEM, and otherwise `localSecrets()`'s directory on this machine.

  `hot-updater keys generate --secret [name]` stores the private key as that secret, `bundle-signing-key` by default, through the config's adapter, or in `localSecrets()`'s directory on this machine (`~/.hot-updater/secrets/<project-key>/<name>.json`, readable by you alone) without one, and writes only `public-key.pem`. It never replaces a secret it reads a value from.

- ed37acf: `hot-updater native-build ios` and `hot-updater native-build android` build native apps, without `EXPERIMENTAL`: `native-build <platform> [-s <scheme>] [-o <path>] [--submit testflight|play-internal] [--dry-run] [--json]`, beside `native-build find`, `native-build delete`, and `native-build import`. They replace the experimental `build:ios` and `build:android`; `run:ios` and `run:android` are removed, with no alias: install the artifact (`xcrun simctl install`, `adb install`) or use your framework's run command. Without `--scheme`, the build asks for the scheme at a terminal, and in CI or without a terminal stops with the schemes to pass. A build returns and prints the artifact (`.apk`, `.aab`, `.ipa`, or simulator `.app`) with the values compiled into it: the MIN_BUNDLE_ID, the fingerprint hash or app version, and the default channel (the app version and channel are read from the built artifact: the app's Info.plist on iOS, and with the SDK's `aapt2` the merged manifest of the `.apk` or `.aab` on Android). The build adapter's `prebuild`, such as `expo prebuild`, now runs before the commands read the native projects. The CLI issues each MIN_BUNDLE_ID as the SDK's podspec script phase and Gradle task do, the UUIDv7 of the build's millisecond with zero random bits, stepped 1 ms forward past a bundle the registry already holds at it; a build whose MIN_BUNDLE_ID another build registered first, as one started in the same millisecond can, is refused when it is tracked, with an error that says so.

  `hot-updater native-build import <file> [-c <channel>] [--dry-run] [--json]` tracks an `.ipa`, `.aab`, `.apk`, or simulator `.app` (the directory or its `.app.zip`) built elsewhere, such as by another build service or an earlier release, as `native-build ios|android` tracks its own builds, with the build number it reports as the row's `build_number`, so OTAs deployed after it patch from its built-in bundle. It reads everything from the artifact: the platform, app version, build number, and app ID from the manifest or Info.plist, the channel the app reports (`production` without one), the MIN_BUNDLE_ID and the fingerprint from the string literals of the app's code (the dex files' string pool, or the Mach-O `__cstring` section of the executable or of HotUpdater's dynamic framework), and the built-in bundle. It prints what it read, then refuses an artifact without a built-in bundle (a Debug build), one built without `@hot-updater/react-native`'s build step (no MIN_BUNDLE_ID) or with several candidates, one without a fingerprint under the fingerprint strategy or without a comparable app version under the appVersion strategy, a channel given as a resource reference (unless `--channel` names the channel the app reports, as when its code sets one or it switches at runtime), and an artifact whose MIN_BUNDLE_ID is registered with another built-in bundle or scope, naming that native build. Importing the same build again succeeds and changes nothing, reporting `alreadyImported: true` under `--json`, so CI jobs can rerun. An app ID no `nativeBuild` scheme's `bundleIdentifier` or `applicationId` (by default its `packageName`) names is a warning. It then uploads the artifact and the built-in bundle and registers them with no build key and no commit; `--dry-run` reads and checks, and records nothing. The reader treats every artifact as untrusted input: it reads only the entries it needs through the zip's central directory, caps the directory, each entry it reads, and all it inflates, stops an entry that inflates past its declared size (a zip bomb), matches no absolute or `..` entry name and refuses a symbolic link or a doubled name among those it reads, writes nothing to disk by entry name, gives up after two minutes, and refuses a truncated or malformed archive, plist, or manifest as unreadable instead of crashing. `@hot-updater/protocol/native-artifact`, a subpath no app imports, exports the reader (`readNativeArtifact` over a `blobSource`, with no dependencies) and `checkNativeArtifact`.

  A `nativeBuild` scheme signs with a credential the CLI resolves while it builds: `signing: { keystore }` on Android passes an `android-keystore` to Gradle as the injected signing properties of release variants, and `signing: { ascApiKey }` on iOS signs device builds with automatic signing through an `asc-api-key`. Debug variants and simulator builds resolve nothing. With `signing.ascApiKey` and no `exportOptionsPlist`, an iOS device build exports for App Store Connect, and `native-build ios` refuses a device scheme with neither before it builds. The helpers' `minBundleId` and `credentials` are optional: without them, `buildAndroid` and `buildIos` issue a MIN_BUNDLE_ID of the build's millisecond (`createMinBundleId` from `@hot-updater/cli-tools`) and resolve signing credentials from the environment. `@hot-updater/android-helper` and `@hot-updater/apple-helper` no longer export `runAndroid`, `runIos`, or their device types. The build log in `.hot-updater/log` keeps the whole output of `xcodebuild` (also with `xcbeautify` installed, which now only formats the progress) or Gradle, through its last line. A failed build prints why on stderr, in `--json` mode too: `xcodebuild`'s `error:` lines and failed commands, or Gradle's `What went wrong` block, else the output's last 40 lines, then `Build log: <path>`, instead of the raw start of the tool's output; the helpers throw a `BuildFailedError` (`@hot-updater/cli-tools`) with the log's path and those lines.

- b78660b: Fixes from integrated QA.
  - The CLI masks a stored value shorter than six characters, such as `1`, only where it is a whole word, as in `PASSWORD=1`, so URLs and versions stay readable.
  - `hot-updater channel delete --json` keeps stdout one JSON document when a native build keeps the channel.
  - `native-build android` prints "App Module" in its Gradle settings.

- 4e4ddfb: `deploy` and `keys export-public` say why remote signing failed instead of only "Failed to resolve the bundle signing provider public key.", and `deploy` prints it as a signing configuration error rather than exiting with a stack trace.
  - `remoteSigning` names the signing endpoint's status, and the `{ error }` or `{ error: { code, message } }` it answered with, with the signing token masked. It also says when `HOT_UPDATER_SIGNING_TOKEN` is not set, and which endpoint it could not reach.
  - Every other signing adapter error stays redacted, as it may quote key material.
  - `doctor` reports the warning `SIGNING_PUBLIC_KEY_UNAVAILABLE` with the reason when it cannot read the configured signer's public key, such as `remoteSigning` without `HOT_UPDATER_SIGNING_TOKEN`, instead of `PUBLIC_KEY_MISMATCH`, whose resolution was a new native release.

- f017e61: The CLI reads secrets through the `secrets` adapter in `hot-updater.config.ts`, `localSecrets()` by default, which `init` writes: `secrets: localSecrets()`. `localSecrets()` reads a name from the environment, then from a JSON file on this machine, `~/.hot-updater/secrets/<project-key>/<name>.json`: a directory only your user can open (0700) holding files only your user can read (0600), in your home directory, so `rm -rf node_modules` keeps it and it is never committed. The project key is the project directory's name and a hash of its path, so each checkout has its own; `HOT_UPDATER_HOME` moves `~/.hot-updater`. `localSecrets({ path })` names the directory instead: `~` is the home directory, a relative path is the project's, and a directory in a git work tree must be one git ignores, or its first use fails. Keys Hot Updater issues after a sign-in, and credentials `secrets put` imports, go there, and the next build on this machine reads them with no step in between. With another adapter, builds read a credential it does not hold from the same default directory, where a key goes when the adapter stores nothing. `.env.hotupdater` stays the deploy-settings file managed `init` writes: Hot Updater never writes a key there.

  `localSecrets()` is the one built-in adapter, an export of `hot-updater` beside `defineConfig` and `secretEnv`, which also re-exports the `SecretsAdapter` and `SecretsContext` types from `@hot-updater/plugin-core`. The provider packages ship their cloud's store. `secretsManager({ region, prefix?, credentials?, endpoint? })` from `@hot-updater/aws` keeps each name as the AWS Secrets Manager secret `<prefix><name>` (`hot-updater/` by default) on the AWS SDK's default credential chain: GitHub Actions OIDC through `aws-actions/configure-aws-credentials` in CI, a profile or AWS SSO on your machine. `set` puts a new version, or creates the secret without tags; a missing secret reads as `undefined`, and a refused permission, expired credentials, or a secret scheduled for deletion fail with what to do. `secretManager({ projectId, prefix?, credentials? })` from `@hot-updater/firebase` keeps each name as the Google Cloud Secret Manager secret `<prefix><name>` (`hot-updater-` by default), read at `latest`, through the REST API and the `google-auth-library` firebase-admin already installs: Application Default Credentials on your machine, Workload Identity Federation through `google-github-actions/auth` in CI, or an access token. `set` adds a version, waits until `latest` resolves to it, and destroys only the versions it added before; a project without the Secret Manager API says to enable `secretmanager.googleapis.com`. Both load their SDK on the first read or write, so a config or server that only imports `s3Storage` or `firebaseStorage` never loads it, and mask every value and credential in the CLI's output. For another store, write an adapter: the docs have a short one for dotenvx (encrypted values committed to the repository), Bitwarden Secrets Manager, 1Password, and Infisical, each on the vendor's own SDK. `SecretsAdapter` is the contract: `get(names, { cwd })` reads names in one call, `undefined` for a name the store does not hold and a thrown error for any other failure, and the optional `set(name, value, { cwd })` and `describe(name)` store a value and say where it is.
  - Native build `signing.keystore` and `signing.ascApiKey` name a secret as `secret:<name>`, such as `"secret:release-keystore"`. A credential is one JSON value per name: `{"keyId","issuerId","p8"}` for an App Store Connect key, `{"keystore","storePassword","keyAlias","keyPassword"}` with the keystore in base64, and a Play service account's own JSON. `localSecrets()` reads a name from its environment variable first: a variable name as it is, such as `CLOUDFLARE_API_TOKEN`, and another name upper-cased after `HOT_UPDATER_`, such as `HOT_UPDATER_ASC_API_KEY` for `asc-api-key`, as a workflow maps a GitHub Actions secret. The `HOT_UPDATER_ASC_KEY*`, `HOT_UPDATER_ANDROID_KEYSTORE_*`, and `HOT_UPDATER_PLAY_SERVICE_ACCOUNT_*` variables still override each kind. Items a build asks for together are read in one `get`, file values are 0600 temporary files, and each value is masked in the CLI's output with every secret field of it; IDs, the key alias, and a service account's email stay readable.
  - `secretEnv([...names])` from `hot-updater` returns a function a config's adapters call for their deploy credentials: names set in the environment or `.env.hotupdater` win, the others come from the config's `secrets` adapter, and the values go only to the caller, never into `process.env`. With `localSecrets()`, every name must be set in the environment: its files hold only keys Hot Updater stores. It refuses variables that change how a process loads code, such as `NODE_OPTIONS`, `PATH`, `LD_*`, `DYLD_*`, `GIT_*`, `npm_config_*`, and the JVM's, Gradle's, Ruby's, Python's, and Perl's options, and those Hot Updater reads its credentials from, `HOT_UPDATER_HOME` included (`isReservedVariableName` in `@hot-updater/cli-tools`).
  - `hot-updater secrets put <name> --kind <asc-api-key|android-keystore|play-service-account>` stores a credential you have, from its files, as that JSON value through the adapter's `set`, or in `localSecrets()`'s directory. `hot-updater secrets issue <asc-api-key|play-service-account> [name]`, or its shortcuts `hot-updater apple login` and `hot-updater google-play login`, instead signs in with your Apple Account or Google and stores the key Hot Updater issues the same way. A sign-in never starts in CI or without a terminal, and a key that surely was not stored is revoked again.
  - Keys stay per machine: on a machine without one, the CLI says before signing in that it will issue a new key, and how to share one key instead (a store every machine reads, or `secrets put`); after issuing, it names where to revoke the keys no machine uses anymore. With `localSecrets()`, and with a GitHub remote and your GitHub token, it offers once to store the issued key as a GitHub Actions secret too, which a workflow maps into the job's environment, where `localSecrets()` reads it first: CI needs no adapter.

- 5e7a045: The adapters a config creates check their credentials and create their clients on first use, so a config loads without them: `supabaseStorage`, `supabaseDatabase`, `azureBlobStorage`, `cosmosDatabase`, `vercelBlobStorage`, `firebaseStorage`, `standaloneRepository`, `awsKmsSigning`, `googleCloudKmsSigning`, and `remoteSigning`. A server runtime missing a credential now reports it at its first request instead of at startup. `makeEnv` takes `expectedContent` and rewrites only a file that still holds it. In `@hot-updater/cli-tools`, `parseLoadedEnv` and `readLoadedHotUpdaterEnv(cwd)` read an env file as `process.loadEnvFile` does, and `readHotUpdaterEnv` is removed: read `.env.hotupdater` with `readLoadedHotUpdaterEnv(cwd)`, as the config loads it, or `readHotUpdaterInitEnv(cwd).managedEnv`, as init reads it.

### Patch Changes

- 8c675a2: CLI prompts refuse to ask without a terminal instead of waiting: `keys export-public` names `-y` and `-p`, `keys remove`, `db migrate`, `db generate`, and `native-build ios|android` without `--scheme` name the option that skips the prompt, and every other prompt fails with an error. `native-build find` no longer runs the build adapter's prebuild, so a lookup leaves `ios/` and `android/` as they are: the Expo adapter reports the app version and channel `expo prebuild` would write from the Expo config (`nativeBuild.getNativeProjectValues`), and other adapters' native projects are read as they are. `hot-updater native-build delete <id>` deletes a registered native build, its built-in bundle, and its stored artifact, through core's new `deleteNativeBuild` and the admin API's `DELETE /native-builds/:id`.
- f5cffc0: `hot-updater native-build ios|android`, and `buildAndroid` and `buildIos` without a `minBundleId`, issue the MIN_BUNDLE_ID the SDK's podspec script phase and Gradle task generate: the UUIDv7 of the build's millisecond with all-zero random bits (`<ts>-<ts>-7000-8000-000000000000`), instead of a platform byte and random bits. `createMinBundleId(nowMs?)` from `@hot-updater/cli-tools` takes no platform. Before a tracked build, the CLI reads the registry once and steps the ID 1 ms forward while a bundle holds it. Two builds that start in the same millisecond, such as an iOS and an Android job of one CI run, still get the same ID: the registry refuses the second registration, and `native-build` now says another build registered that built-in bundle first and to build again, instead of `native_builds: exists`. The build cache doesn't reuse this machine's cached build when another build registered its MIN_BUNDLE_ID, so building again issues a new one. `native-build import` and every reader keep accepting any UUIDv7, so artifacts an earlier CLI built, whose MIN_BUNDLE_ID has a platform byte, still import.
- Updated dependencies [8c675a2]
- Updated dependencies [28dfe97]
- Updated dependencies [84b21f0]
- Updated dependencies [0050ff3]
- Updated dependencies [1ad0ebe]
- Updated dependencies [89cd5ce]
- Updated dependencies [79c81f6]
- Updated dependencies [4d8e0d2]
- Updated dependencies [ed37acf]
- Updated dependencies [4e4ddfb]
- Updated dependencies [f017e61]
- Updated dependencies [5e7a045]
  - @hot-updater/plugin-core@1.2.0-rc.0
  - @hot-updater/server@1.2.0-rc.0
  - @hot-updater/protocol@1.2.0-rc.0

## 1.1.5

### Patch Changes

- @hot-updater/protocol@1.1.5
  - @hot-updater/server@1.1.5
  - @hot-updater/plugin-core@1.1.5

## 1.1.4

### Patch Changes

- @hot-updater/protocol@1.1.4
  - @hot-updater/server@1.1.4
  - @hot-updater/plugin-core@1.1.4

## 1.1.3

### Patch Changes

- @hot-updater/protocol@1.1.3
  - @hot-updater/server@1.1.3
  - @hot-updater/plugin-core@1.1.3

## 1.1.2

### Patch Changes

- 007e0c5: Require Node.js 22.23.4+, 24.22.1+, or 26.12.1+, the releases that fix CVE-2026-111497 in Node's Brotli decoder. Node.js 20 is end of life and gets no fix.

  Patch creation (`hot-updater patch` and the patches `deploy` creates) first checks each manifest against the bundle's recorded `manifestFileHash`, verifying a signed one with the configured signing public key, then checks every Hermes bundle it downloads against the manifest's SHA-256 hashes, a Brotli-compressed one before decoding it. Storage bytes that deploy did not upload no longer reach the Brotli decoder or a patch.

- @hot-updater/protocol@1.1.2
  - @hot-updater/server@1.1.2
  - @hot-updater/plugin-core@1.1.2

## 1.1.1

### Patch Changes

- @hot-updater/protocol@1.1.1
  - @hot-updater/server@1.1.1
  - @hot-updater/plugin-core@1.1.1

## 1.1.0

### Minor Changes

- 7eaad78: Fingerprint Expo apps with Hot Updater's interface engine and drop `@expo/fingerprint`.
  - The Expo build adapter now provides its own fingerprint with the bare and Rock adapters' engine. It reads the native packages from Expo's autolinking (React Native CLI on SDKs before 52 or with `EXPO_USE_COMMUNITY_AUTOLINKING=1`), and `jsEngine` and `newArchEnabled` from the app config. It never reads the generated `ios/` and `android/` folders, so `fingerprint create` before `expo prebuild` and the native build after it compute the same fingerprint. Changing `jsEngine` or `newArchEnabled` now changes the fingerprint; it didn't before. `jsEngine` counts as `hermes` when the app config leaves it out, as Expo builds. Config plugins don't count, like edits to a bare app's native projects: bump `fingerprint.nativeVersion` when one changes what JavaScript can call.
  - `fingerprint hash` embeds the recorded fingerprint with a warning when the build adapter `fingerprint.json` records is not installed.
  - The interface engine no longer reads `Podfile.lock`, which only exists after `pod install` and depends on the machine that ran it. An iOS engine choice made by an environment variable at `pod install` goes through `fingerprint.nativeVersion`.
  - `hot-updater` no longer depends on `@expo/fingerprint`. A build adapter without its own fingerprint gets React Native CLI's.
  - Expo projects and bare iOS fingerprints change once, so builds made before the upgrade need a rebuild to keep receiving updates.

- 60db3ea: The bare and Rock build adapters fingerprint the native interface JavaScript calls with Hot Updater's own engine, `hot-updater/interface@1`, instead of `@expo/fingerprint`. The fingerprint covers:
  - the React Native version and its JavaScript engine (`hermesEnabled`, `hermesV1Enabled`, and `newArchEnabled` in `android/gradle.properties`);
  - each autolinked native package by name and version, Expo modules included;
  - the codegen specs of the app and of local native packages;
  - patches to those packages;
  - the new `fingerprint.nativeVersion` setting and `extraSources`.

  Version and build numbers, native implementation edits, build settings, and JavaScript-only dependencies no longer change it, so OTA updates keep reaching every store build with the same native interface.

  This changes the fingerprint of bare and Rock projects once. `doctor` and `deploy` report the change as an engine change. Run `npx hot-updater fingerprint create` and ship new store builds. Builds shipped with the old fingerprint receive no updates until users install a new build.

  Build adapters can provide their own fingerprint through `nativeBuild.fingerprint` (`NativeFingerprintProvider` in `@hot-updater/plugin-core`). The Expo adapter uses the same engine (see the Expo changeset). Fingerprint changes list values before and after, such as `react-native-screens 4.25.2 → 4.26.0`.

  When the channel's recent releases target other fingerprints, `deploy` lists them, so you see which builds the update won't reach.

### Patch Changes

- Updated dependencies [7eaad78]
- Updated dependencies [60db3ea]
- Updated dependencies [99d0356]
  - @hot-updater/plugin-core@1.1.0
  - @hot-updater/protocol@1.1.0
  - @hot-updater/server@1.1.0

## 1.0.8

### Patch Changes

- @hot-updater/protocol@1.0.8
  - @hot-updater/server@1.0.8
  - @hot-updater/plugin-core@1.0.8

## 1.0.7

### Patch Changes

- @hot-updater/protocol@1.0.7
  - @hot-updater/server@1.0.7
  - @hot-updater/plugin-core@1.0.7

## 1.0.6

### Patch Changes

- Updated dependencies [5702bf5]
  - @hot-updater/plugin-core@1.0.6
  - @hot-updater/protocol@1.0.6
  - @hot-updater/server@1.0.6

## 1.0.5

### Patch Changes

- @hot-updater/protocol@1.0.5
  - @hot-updater/server@1.0.5
  - @hot-updater/plugin-core@1.0.5

## 1.0.4

### Patch Changes

- 33bdc32: `@hot-updater/vercel` re-exports `postgres`, so a managed Vercel project installs only `@hot-updater/vercel`. `hot-updater init` writes `import { postgres, vercelBlobStorage } from "@hot-updater/vercel"` and, on a rerun, moves an existing `postgres` import from `@hot-updater/postgres` there. You can then remove `@hot-updater/postgres` from the app's devDependencies.
- @hot-updater/protocol@1.0.4
  - @hot-updater/server@1.0.4
  - @hot-updater/plugin-core@1.0.4

## 1.0.3

### Patch Changes

- 407ec2c: Arrays in `hot-updater.config` now replace the defaults instead of being merged into them index by index. `platform.ios.infoPlistPaths` and `platform.android.androidManifestPaths` could not narrow the files the CLI discovers: listing one Info.plist in a project with three only overwrote the first discovered path and kept the other two, so commands such as `fingerprint create` and `keys export-public` still wrote to app extensions and test targets, and a manifest listed explicitly could be written twice.
- @hot-updater/protocol@1.0.3
  - @hot-updater/server@1.0.3
  - @hot-updater/plugin-core@1.0.3

## 1.0.2

### Patch Changes

- ddfb139: Add the Azure provider, `@hot-updater/azure`: `azureBlobStorage` keeps bundles in Azure Blob Storage and serves them through SAS URLs, and `cosmosDatabase` runs Hot Updater's database in one Azure Cosmos DB for NoSQL container, with `migrateCosmosDatabase` to create it and write the schema settings. `hot-updater init` sets up Azure with the Azure CLI: it creates a storage account, a serverless Cosmos DB account with strong consistency, and a Flex Consumption Function App, migrates the database, deploys the Hot Updater Function, and creates the client API key. `hot-updater agent infra setup` and `hot-updater infra scaffold` take `--provider azure`.
- d4d1d07: Add Vercel as a managed provider. `hot-updater init` can now set up Hot Updater on Vercel: it selects the team, creates or reuses the project, selects or creates a Blob store (private by default) and connects it to the project, and takes a Postgres database connected to the project, a new Neon database from the Vercel Marketplace, or a connection URL. It then migrates the database, deploys the prebuilt Hot Updater Function to production, and issues the first API key. The new `@hot-updater/vercel` package exports `vercelBlobStorage`, and the generated config uses `postgres` from `@hot-updater/postgres`. `hot-updater agent infra` and `infra scaffold` take `--provider vercel`.
- @hot-updater/protocol@1.0.2
  - @hot-updater/server@1.0.2
  - @hot-updater/plugin-core@1.0.2

## 1.0.1

### Patch Changes

- Updated dependencies [4e7c9c9]
  - @hot-updater/protocol@1.0.1
  - @hot-updater/server@1.0.1
  - @hot-updater/plugin-core@1.0.1

## 1.0.0

### Major Changes

- adb0e40: Hot Updater 1.0, the first stable release of v1. Deploys create Releases that the server compiles into one cacheable Release Catalog per app scope, and `createHotUpdater` runs a storage adapter, a database adapter, and plugins such as Insights, Remote Config, and client API keys. v1 runs on new infrastructure and needs a new native app build: follow the [upgrade guide](https://hot-updater.dev/docs/guides/upgrade-to-v1) and [BREAKING_CHANGES.md](https://github.com/gronxb/hot-updater/blob/main/BREAKING_CHANGES.md) to move from v0.

### Patch Changes

- Updated dependencies [adb0e40]
  - @hot-updater/plugin-core@1.0.0
  - @hot-updater/protocol@1.0.0
  - @hot-updater/server@1.0.0

## 1.0.0-rc.47

### Patch Changes

- 7132080: A database whose settings carry `schema.core` without `schema.engine` is no longer refused separately: the schema fence and `hot-updater db migrate` treat it like any unmigrated database. A v0 database is still refused, with the advice to create a new empty database and run `hot-updater db migrate`. `standaloneRepository` no longer sends a `v` query parameter with admin requests, and `hot-updater init` no longer looks for a `hotUpdater.plugins.ts` file or, on Firebase and Supabase, for collections and tables outside the storage engine's layout. A plugin with a `kind` key fails with the unknown-key error.
- Updated dependencies [5891d9b]
- Updated dependencies [ccf3e2f]
- Updated dependencies [7132080]
- Updated dependencies [ccf3e2f]
  - @hot-updater/plugin-core@1.0.0-rc.47
  - @hot-updater/protocol@1.0.0-rc.47
  - @hot-updater/server@1.0.0-rc.47

## 1.0.0-rc.46

### Minor Changes

- 47638d6: Remove code that only served v0. No v1 code called it.
  - `@hot-updater/cli-tools` no longer exports the copy-promote helpers `createCopiedBundleArtifacts` and `LEGACY_BUNDLE_ERROR`, or `writeStorageFile` and `writeStorageResponseFile`. Promotion runs through core.
  - `hot-updater` no longer exports `getPublicKeyFromPrivate` or `loadPrivateKey`. `hot-updater channel set` help names AndroidManifest.xml, where the channel is written.
  - `@hot-updater/protocol` no longer exports `stripBundleArtifactMetadata`, which returned its input.
  - `@hot-updater/plugin-core` no longer exports `filterCompatibleAppVersions`.
  - `@hot-updater/server` no longer re-exports protocol's `Bundle` type from its root; import it from `@hot-updater/protocol`. `@hot-updater/server/adapters/kysely` no longer exports the `SQLProvider` alias; use `SqlDialect` from `@hot-updater/plugin-core`.
  - `@hot-updater/cloudflare` no longer exports `./worker/config` or `./worker/wrangler.json`.
  - `@hot-updater/react-native` calls `getBundleId()`, `getManifest()`, and Android's `reloadProcess()` directly, which every v1 native module implements. It no longer reads a `PROMOTED` launch report or manifest assets given as plain strings.
  - The Expo config plugin no longer rewrites the `getJSBundleFile` code that its v0 releases injected without a debug check.
  - `@hot-updater/supabase/edge` exports `supabaseStorage` directly. The name and config are unchanged.
  - The Console drops the unused `getBundles` and `getConfigLoaded` server functions and their query hooks.

### Patch Changes

- Updated dependencies [47638d6]
- Updated dependencies [19be90f]
  - @hot-updater/protocol@1.0.0-rc.46
  - @hot-updater/plugin-core@1.0.0-rc.46
  - @hot-updater/server@1.0.0-rc.46

## 1.0.0-rc.45

### Patch Changes

- @hot-updater/protocol@1.0.0-rc.45
  - @hot-updater/server@1.0.0-rc.45
  - @hot-updater/plugin-core@1.0.0-rc.45

## 1.0.0-rc.44

### Patch Changes

- 92971a0: Export official plugin factories from `hot-updater/plugins` and generate explicit plugin arrays in managed configs, matching the server and client configuration pattern.

  Reuse official server factories through the CLI entry when rerunning init, preserve plugin files still needed by existing configs, and propagate Firebase config write failures. Report config shapes that could override the generated plugin list instead of claiming a successful merge.

- 13d2119: `createHotUpdater` requires one storage adapter, `storage: s3Storage({ ... })`, the same adapter `hot-updater.config.ts` uploads with, and `hotUpdater.storage` is that adapter. Startup throws without it. `setupDatabaseTestSuite`'s `createHttpClient` receives one adapter too.

  `clientAccess` takes only `"public"`. Options that no longer exist, in `createHotUpdater` and `hot-updater.config.ts`, are left to TypeScript instead of runtime checks.

  A Release Catalog path with a channel name in place of its key, or a malformed fingerprint hash, answers `400` instead of `500`. `standaloneRepository` stops with a message when `baseUrl` points at the client mount instead of `handlers.admin`. `hot-updater init` no longer writes a storage call that uses a helper it removed.

- Updated dependencies [13d2119]
- Updated dependencies [13d2119]
- Updated dependencies [92971a0]
  - @hot-updater/server@1.0.0-rc.44
  - @hot-updater/plugin-core@1.0.0-rc.44
  - @hot-updater/protocol@1.0.0-rc.44

## 1.0.0-rc.43

### Patch Changes

- Updated dependencies [23c14fa]
  - @hot-updater/server@1.0.0-rc.43
  - @hot-updater/protocol@1.0.0-rc.43
  - @hot-updater/plugin-core@1.0.0-rc.43

## 1.0.0-rc.42

### Patch Changes

- @hot-updater/server@1.0.0-rc.42
  - @hot-updater/protocol@1.0.0-rc.42
  - @hot-updater/plugin-core@1.0.0-rc.42

## 1.0.0-rc.41

### Patch Changes

- Updated dependencies [545f059]
- Updated dependencies [545f059]
- Updated dependencies [545f059]
  - @hot-updater/protocol@1.0.0-rc.41
  - @hot-updater/server@1.0.0-rc.41
  - @hot-updater/plugin-core@1.0.0-rc.41

## 1.0.0-rc.40

### Patch Changes

- @hot-updater/protocol@1.0.0-rc.40
  - @hot-updater/server@1.0.0-rc.40
  - @hot-updater/plugin-core@1.0.0-rc.40

## 1.0.0-rc.39

### Patch Changes

- Updated dependencies [2071bc6]
  - @hot-updater/server@1.0.0-rc.39
  - @hot-updater/plugin-core@1.0.0-rc.39
  - @hot-updater/protocol@1.0.0-rc.39

## 1.0.0-rc.38

### Patch Changes

- Updated dependencies [bbbdd8c]
  - @hot-updater/server@1.0.0-rc.38
  - @hot-updater/plugin-core@1.0.0-rc.38
  - @hot-updater/protocol@1.0.0-rc.38

## 1.0.0-rc.37

### Patch Changes

- Updated dependencies [5a5dd3e]
  - @hot-updater/server@1.0.0-rc.37
  - @hot-updater/plugin-core@1.0.0-rc.37
  - @hot-updater/protocol@1.0.0-rc.37

## 1.0.0-rc.36

### Patch Changes

- Updated dependencies [c527bb2]
  - @hot-updater/protocol@1.0.0-rc.36
  - @hot-updater/server@1.0.0-rc.36
  - @hot-updater/plugin-core@1.0.0-rc.36

## 1.0.0-rc.35

### Patch Changes

- @hot-updater/protocol@1.0.0-rc.35
  - @hot-updater/server@1.0.0-rc.35
  - @hot-updater/plugin-core@1.0.0-rc.35

## 1.0.0-rc.34

### Patch Changes

- Updated dependencies [48241d4]
  - @hot-updater/protocol@1.0.0-rc.30
  - @hot-updater/server@1.0.0-rc.34
  - @hot-updater/plugin-core@1.0.0-rc.30

## 1.0.0-rc.33

### Patch Changes

- Updated dependencies [9fe6dfd]
  - @hot-updater/server@1.0.0-rc.33
  - @hot-updater/plugin-core@1.0.0-rc.29

## 1.0.0-rc.32

### Patch Changes

- Updated dependencies [384a5b6]
  - @hot-updater/protocol@1.0.0-rc.29
  - @hot-updater/server@1.0.0-rc.32
  - @hot-updater/plugin-core@1.0.0-rc.29

## 1.0.0-rc.31

### Patch Changes

- Updated dependencies [d846556]
  - @hot-updater/server@1.0.0-rc.31
  - @hot-updater/plugin-core@1.0.0-rc.28

## 1.0.0-rc.30

### Patch Changes

- @hot-updater/server@1.0.0-rc.30
  - @hot-updater/plugin-core@1.0.0-rc.28

## 1.0.0-rc.29

### Patch Changes

- Updated dependencies [80bb792]
  - @hot-updater/protocol@1.0.0-rc.28
  - @hot-updater/server@1.0.0-rc.29
  - @hot-updater/plugin-core@1.0.0-rc.28

## 1.0.0-rc.28

### Patch Changes

- @hot-updater/server@1.0.0-rc.28

## 1.0.0-rc.27

### Patch Changes

- Improve the readability of Console update failures by grouping check metrics separately, emphasizing nonzero failures, and making stage/reason details easier to scan. Preserve all report data and rate calculations. Prepare all public Hot Updater packages together as 1.0.0-rc.27.
- Updated dependencies
  - @hot-updater/plugin-core@1.0.0-rc.27
  - @hot-updater/protocol@1.0.0-rc.27
  - @hot-updater/server@1.0.0-rc.27

## 1.0.0-rc.26

### Patch Changes

- c9cfed7: Restore the rc.14 Insights metric layout in bundle rows and details while preserving current data, rates, links, and download failure reporting. Release all public Hot Updater packages together as 1.0.0-rc.26.
- Updated dependencies [c9cfed7]
  - @hot-updater/plugin-core@1.0.0-rc.26
  - @hot-updater/protocol@1.0.0-rc.26
  - @hot-updater/server@1.0.0-rc.26

## 1.0.0-rc.25

### Patch Changes

- c9cfed7: Release the legacy Hermes fallback correction at 1.0.0-rc.25 with all public Hot Updater packages on the same RC.
- Updated dependencies [c9cfed7]
  - @hot-updater/plugin-core@1.0.0-rc.25
  - @hot-updater/protocol@1.0.0-rc.25
  - @hot-updater/server@1.0.0-rc.25

## 1.0.0-rc.24

### Patch Changes

- cc34295: Resolve Expo config and fingerprint dependencies from the target app with Node's package resolver. Remove Expo config file-path fallbacks, honor evaluated dynamic and platform-specific JavaScript engine settings, and preserve config and dependency errors.

  Resolve React Native metadata through its package manifest and legacy Hermes binaries from the app's dependencies, including hoisted installations.

- c9cfed7: Release the project-scoped Expo, fingerprint, React Native, and Hermes resolution fixes at 1.0.0-rc.24 so projects can install the same RC of every Hot Updater package.
- Updated dependencies [c9cfed7]
  - @hot-updater/plugin-core@1.0.0-rc.24
  - @hot-updater/protocol@1.0.0-rc.24
  - @hot-updater/server@1.0.0-rc.24

## 1.0.0-rc.23

### Patch Changes

- c9cfed7: Release with the Expo SDK 58 config fix at 1.0.0-rc.23 so projects can install the same RC of every Hot Updater package.
- Updated dependencies [c9cfed7]
  - @hot-updater/plugin-core@1.0.0-rc.23
  - @hot-updater/protocol@1.0.0-rc.23
  - @hot-updater/server@1.0.0-rc.23

## 1.0.0-rc.22

### Patch Changes

- c9cfed7: Released with every Hot Updater package at 1.0.0-rc.22, so a project can install the same RC of each one.
- Updated dependencies [c9cfed7]
  - @hot-updater/plugin-core@1.0.0-rc.22
  - @hot-updater/protocol@1.0.0-rc.22
  - @hot-updater/server@1.0.0-rc.22

## 1.0.0-rc.21

### Minor Changes

- ab04e15: `hot-updater.config.ts` takes `plugins` beside `storage` and `database`: the server plugins the server runs. The config mirrors the server, so plugins are listed in three places: the server's `createHotUpdater({ plugins })`, `plugins` in `hot-updater.config.ts`, and the app's `HotUpdater.init({ plugins })`. A managed project lists them in two, the config and the app, since its prebuilt server runs the provider package's `plugins`.

  ```ts
  import { apiKeys } from "@hot-updater/server/plugins/api-keys";
  import { insights } from "@hot-updater/server/plugins/insights";

  export default defineConfig({
    build: bare(),
    storage: s3Storage({ ... }),
    database: standaloneRepository({ baseUrl, commonHeaders }),
    plugins: [insights(), apiKeys()],
    updateStrategy: "appVersion",
  });
  ```

  - `hotUpdater.plugins.ts` is no longer read. `hot-updater init` writes the provider package's `plugins` into `hot-updater.config.ts`, beside its storage and database, removes the `hotUpdater.plugins.ts` that an earlier init generated, and names one the project wrote. When it cannot edit the config, such as one whose own import takes a name init imports, like the project's own `plugins` list, it keeps the file unchanged and prints the storage, database, and plugins to set.
  - A managed project that an earlier release candidate's init set up, such as rc.20's, keeps its plugins in the generated `hotUpdater.plugins.ts`. Rerun `hot-updater init --provider <provider>`, which writes `plugins` into `hot-updater.config.ts` and removes that file, or add `plugins` from the provider package to `hot-updater.config.ts` and delete the file. Until then, `hot-updater console` shows neither Insights nor API keys, `hot-updater api-key` stops with an error, and `hot-updater doctor` checks no client plugins.
  - The CLI writes through the core it assembles from `database` and `plugins`, as `createHotUpdater` does: a listed plugin whose migration has not run stops a command, and writes on SQL databases delete the plugins' expired rows.
  - `hot-updater deploy` without `-p` loads `hot-updater.config` once for both platforms. A config object gives both the same `database` and `storage`, so one command deploys both, where rc.20 refused it even for a config object. A config function runs once per platform, so create its adapters outside the function and return the same ones; otherwise deploy stops before it builds with "Deploying multiple platforms requires a shared database configuration." or "Deploying multiple platforms requires a shared storage configuration."
  - `hot-updater doctor`, `hot-updater console`, and `hot-updater api-key` read the server's plugins from `plugins`. A self-hosted app imports the official ones from `@hot-updater/server`, which it installs as a development dependency.
  - `loadConfig` no longer fills a missing `database` or `storage` with a placeholder. `ConfigResponse` has both optional and `plugins` defaulting to `[]`, and a command that needs one says to set it in `hot-updater.config.ts`.
  - `hot-updater db migrate` and `db generate` load the server file named on the command line, which also loads `.env.hotupdater` from the working directory, or else `src/hotUpdater.*` or `src/db.*`. They no longer try `hot-updater.config.*`. `db generate --sql` reads the plugin list from the file named on the command line, then from `plugins` in `hot-updater.config.ts`, then from `src/hotUpdater.*` or `src/db.*`. These commands, and `hot-updater api-key` with a server file, close the file's database when they finish: through its `closeDatabase` export, or else the database's `dispose`.
  - The agent infrastructure scaffold's `app/hot-updater.config.ts` lists `plugins`, and the agent merges its storage, database, and plugins into the app's config. Its credential script provisions the client credential through the scaffold's own `app/hotUpdater.ts`, which replaces `app/database.config.ts` and `app/hotUpdater.plugins.ts` and stays in the scaffold.
  - In `@hot-updater/plugin-core`, `ConfigInput` takes `plugins?: readonly AnyHotUpdaterPlugin[]`.
  - `@hot-updater/cli-tools`:
    - adds `assembleServer({ database, storage, plugins })`, which runs `createHotUpdater` over a config's database, storage, and plugins, and returns them with the `core`, `api`, `clientPlugins`, and `clientAuth` it assembles. Over `standaloneRepository`, `core` is the server's admin API and `api` is `undefined`, since the plugins run on the server. Its types are `AssembleServerOptions` and `AssembledServer`;
    - adds `loadPlatformConfigs(platforms, { channel })`, which loads `hot-updater.config` once and returns each platform's config;
    - adds `writeHotUpdaterFiles(scaffold, { cwd, settings })`, which writes `hot-updater.config.ts` and removes the `hotUpdater.plugins.ts` an earlier init generated;
    - adds `moduleSpecifiersOf(fileName, source)`, which lists the modules a source file imports or re-exports;
    - removes rc.20's plugins file helpers, with no replacement: `HOT_UPDATER_PLUGINS_PATH`, `renderHotUpdaterPlugins`, `writeHotUpdaterPlugins`, `WriteHotUpdaterPluginsResult`, `generateHotUpdaterPlugins`, and `loadHotUpdaterPlugins`. It also removes `IConfigBuilder`, the interface `ConfigBuilder` implemented;
    - `createHotUpdaterConfigScaffold` requires `plugins`, and `ConfigBuilder.getScaffold()` and `getResult()` throw until `setPlugins()` sets them. `ConfigBuilder`'s `setStorage` and `setDatabase` no longer add the `applicationDefault` import from `firebase-admin/app` for Firebase; pass it with `addImport`.

- ab04e15: Plugins no longer add `hot-updater` commands. `PluginCli` keeps `clientCredential` and `clientPlugin`, the metadata that `hot-updater init`, `hot-updater doctor`, and the agent scaffold read, and its `commands` is removed, with no replacement:
  - These names are removed from every package: `PluginCommand`, `PluginCommandArgument`, `PluginCommandOption`, `PluginCommandContext`, `PluginCommandUi`, and `PluginTableColumn`, which rc.20 exported from `@hot-updater/server/plugins`, and `pluginCommandsOf` and `PluginCommandEntry`, which rc.20 exported from `@hot-updater/server/db`.
  - `createHotUpdater` refuses a plugin whose `cli` holds `commands`, or any key other than `clientCredential` and `clientPlugin`, with `HotUpdaterConfigError`.
  - The CLI no longer looks for plugin commands, and `hot-updater --help` no longer lists **Plugin commands**.

  `hot-updater api-key create|list|revoke` is a built-in command again: `create --name <name>`, `list` with `--json`, and `revoke <id>` with `-y`, each with an optional trailing `[serverPath]`. It manages keys through `apiKeys()` over the first of:
  - the server file `serverPath` names, such as `src/hotUpdater.ts` in a server project;
  - `database` and `plugins` in `hot-updater.config.ts`, when the config sets `database`;
  - `src/hotUpdater.*` or `src/db.*`.

  When those plugins lack `apiKeys()`, it says to add it. With `database: standaloneRepository(...)`, it says to run the command in the server project with the server file's path, since the admin API serves no API key routes. The `cli` of `apiKeys()` from `@hot-updater/plugin-api-keys` holds only its `clientCredential`.

- 4d15862: `@hot-updater/core` is renamed `@hot-updater/protocol`: the device-safe, zero-dependency package for what crosses a boundary, the formats and pure computations the app and the server share and the contracts between a host and its extensions on the device, such as the client plugin contract. `@hot-updater/plugin-core` is the kit that extends the server, with the adapter and server plugin contracts and their helpers: it runs wherever the server runs, and the app never imports it.
  - Import from `@hot-updater/protocol` where you imported `@hot-updater/core`. Every Hot Updater package that depended on `@hot-updater/core` depends on `@hot-updater/protocol` instead. `@hot-updater/core` stays on npm for 0.x.
  - `canonicalizeAppVersion` moves to `@hot-updater/protocol`, which bundles the version parsing it uses and has no dependencies. `@hot-updater/plugin-core` exports it as before.
  - `@hot-updater/react-native` no longer depends on `@hot-updater/plugin-core`: the app imports `@hot-updater/protocol` and the built-in Insights client, never `@hot-updater/plugin-core` or `@hot-updater/server`.
  - `@hot-updater/plugin-insights` takes `@hot-updater/plugin-core` as an optional peer dependency, which only its `./server` entry needs, and `@hot-updater/plugin-api-keys` as a peer dependency, so an app that installs `@hot-updater/react-native` no longer installs `@hot-updater/plugin-core`. A server gets it through `@hot-updater/server`.
  - Third-party server plugins and storage, build, and signing adapters import `@hot-updater/plugin-core` and list it in `peerDependencies`; client plugins do the same with `@hot-updater/protocol`. `@hot-updater/plugin-core` now also exports `addDistinct`, `countDistinct`, and `mergeDistinct`, so a plugin imports everything it needs from its root.
  - Client plugins import `defineClientPlugin` and its types from `@hot-updater/protocol`. `@hot-updater/react-native` still exports them for app code.
  - The `@hot-updater/react-native/plugins/insights` subpath is removed: import `insights` and its types from `@hot-updater/react-native`, as in `import { HotUpdater, insights } from "@hot-updater/react-native"`. Metro bundles the Insights client into every app, about 4 KB gzipped; it reports nothing until the app adds it to `plugins`. `hot-updater init` and the agent scaffold print that import, and `hot-updater doctor` looks for it.
  - `@hot-updater/protocol` exports the plugin host the SDK runs client plugins on, for any device SDK to reuse: `createPluginHost`, `pluginStorageKey`, `resolveBaseURL`, `HotUpdaterBaseURL`, and the `PluginHost*` types. `@hot-updater/react-native` has no subpaths, and `@hot-updater/test-utils/react-native` runs client plugins on protocol's host, without `@hot-updater/react-native` as a peer dependency.
  - `@hot-updater/cli-tools` adds `renderAppImports`, which groups the app's imports by module.
  - The `@hot-updater/plugin-core` root exports `definePlugin`, the schema DSL, the typed database handle, and the database errors.

- 049fad1: Tooling reads a server through its definition, the value `createHotUpdater` returns. Beside `core`, `api`, and `handlers`, a definition has public, read-only properties:
  - `database`;
  - `storage` and `plugins`, frozen copies of the arrays the definition was created with;
  - `clientPlugins`;
  - `clientEndpoints`;
  - `clientAuth`, which names the plugin that guards client routes and the request headers its decision reads, in lowercase.

  `@hot-updater/server` now exports only its root, `./adapters/*`, `./plugins/insights`, and `./plugins/api-keys`.

  Removed from `@hot-updater/server`. All of these shipped in rc.18:
  - From `@hot-updater/server/db`:
    - `createDatabaseCoreApi` and `CoreApi`. Use a definition's `core`, typed `HotUpdaterCoreApi` from `@hot-updater/plugin-core`.
    - `createDatabasePluginApis`. Use a definition's `api`. In a test that is, for example, `createHotUpdater({ database, plugins, clientAccess: "public" }).api.insights`.
    - `serverPluginsOf`, `clientPluginsOf`, and `ClientPluginSpec`. Use a definition's `plugins` and `clientPlugins`. A client plugin is typed `PluginClientPlugin` from `@hot-updater/plugin-core`.
    - `HotUpdaterDBTarget`, with no replacement: tooling takes the definition.
    - `HOT_UPDATER_SERVER_VERSION`. Import it from the root.
    - `HotUpdaterSchemaMigrationRequiredError`, `generateEngineSql`, `DatabaseTooling`, `Migrator`, `SchemaGenerator`, `ToolingDatabase`, and `ToolingTarget`. Import them from `@hot-updater/plugin-core`.
    - `clientAuthOf`, `generateClientCredential`, `provisionClientCredential`, `createMigrator`, `generateSchema`, `generatesSchema`, `ClientAuthSpec`, `ClientCredentialSpec`, and `ProvisionedClientCredential`. Import them from `@hot-updater/cli-tools`, where each takes a definition.
  - From `@hot-updater/server/diff`: `createBundleDiff`, `CreateBundleDiffDependencies`, `CreateBundleDiffInput`, and `CreateBundleDiffOptions`. There is no public replacement: the `hot-updater` CLI creates bundle diffs itself, and `@hot-updater/server` no longer depends on `@hot-updater/bsdiff`.

  Over a direct database, the CLI and the console run `createHotUpdater` with the database, storage, and plugins in their config. They write through its `core`, the same path the server's own writes take, and call plugins through its `api`:
  - **Missing plugin migrations.** A command stops before it reads or writes if a plugin's migration has not run. `HotUpdaterSchemaMigrationRequiredError` lists every missing or stale settings row in `settings` and names their plugins in `plugins`. Its message gives the fix for the database:
    - `hot-updater db migrate`, or `hot-updater db generate` for a database migrated from files, run in the server's project: the `db` commands load the server file and don't read `hot-updater.config.ts`;
    - on a managed server, rerunning `hot-updater init --provider <provider>`.
  - **Expired rows on SQL databases.** When a retention pass is due, a write first deletes expired rows from plugins' tables:
    - The server and the CLI share one lease.
    - A pass deletes at most 500 rows from each table.
    - A failed pass, for example one whose credentials cannot delete, logs a warning and the write goes ahead. The pass is due again at once, so the next writer that can delete, such as the server, runs it. The process whose pass failed tries again in a minute.
  - **Key-value databases** (DynamoDB, Firestore) expire rows themselves, so their writes delete nothing.
  - **Storage.** Core resolves file URLs through the server's storage. A server over storage that only uploads, as the CLI's is, can still write, and its `core.getArtifactInfo` returns `null`, because it can neither read nor sign a file.

  Other changes:
  - **`@hot-updater/cli-tools`** adds `serverDefinitionOf` and `isServerDefinition`, which read a definition. Tooling refuses a definition from an older `@hot-updater/server` and says to upgrade it.
  - **Insights test suite.** `insightsTestSuite`'s `createModel` receives the database as an `EngineDatabase`.
  - **Managed init** reads the client headers, client plugins, and credential of the provider's plugins from a server it assembles over the database it set up.
  - **Agent infrastructure scaffolds.** `provision-client-credential.mjs` reads the properties of the scaffold's `app/hotUpdater.ts`, and refuses a clientAuth plugin whose `cli.clientCredential` lacks a label, header, env, `generate`, or `provision`. Firebase's `migrate.ts` imports `toolingTargetOf` from `@hot-updater/plugin-core`, which its app now lists.

### Patch Changes

- c9cfed7: Every package now shares one release candidate version: `hot-updater` and every `@hot-updater/*` package move to the same version, so an app, its server, and the console can pin one version.
- bb57f25: What fills one slot of a config is now an adapter: storage, build, database, and signing. What you list in `plugins` stays a plugin: server plugins, client plugins, and the Sentry, Datadog, and BugSnag integration plugins that wrap a build adapter.
  - `@hot-updater/plugin-core`: `StoragePlugin` is `StorageAdapter`, `createStoragePlugin` is `createStorageAdapter`, `StoragePluginWith` is `StorageAdapterWith`, `CreateStoragePluginOptions` is `CreateStorageAdapterOptions`, `BuildPlugin` is `BuildAdapter`, `BuildPluginConfig` is `BuildAdapterConfig`, `BasePluginArgs` is `BuildAdapterArgs`, `BundleSigningPlugin` is `BundleSigningAdapter`, and `DatabasePluginInputError` is `DatabaseAdapterInputError`. There are no aliases.
  - `@hot-updater/bare`, `@hot-updater/expo`, and `@hot-updater/rock`: their options types are `BareAdapterConfig`, `ExpoAdapterConfig`, and `RockAdapterConfig`.
  - The CLI, the server, and the console say "storage adapter", "build adapter", "database adapter", and "signing adapter" in their messages, such as `Storage adapter "<name>" does not implement <operation>.` and `No storage adapter for protocol: <protocol>`. `hot-updater init --build <adapter>` names its option accordingly.

  Package names and factory names do not change: `s3Storage()`, `r2Storage()`, `bare()`, `expo()`, `rock()`, `postgres()`, and the rest are configured as before.

- Updated dependencies [c9cfed7]
- Updated dependencies [5ec6796]
- Updated dependencies [ab04e15]
- Updated dependencies [73f809e]
- Updated dependencies [f185d6d]
- Updated dependencies [f185d6d]
- Updated dependencies [ab04e15]
- Updated dependencies [4d15862]
- Updated dependencies [9dc4baf]
- Updated dependencies [48cdd14]
- Updated dependencies [049fad1]
- Updated dependencies [0d8d03b]
- Updated dependencies [61fcd51]
- Updated dependencies [bb57f25]
  - @hot-updater/protocol@1.0.0-rc.21
  - @hot-updater/plugin-core@1.0.0-rc.21
  - @hot-updater/server@1.0.0-rc.21

## 1.0.0-rc.17

### Minor Changes

- 9cd555b: Remove `formatApiKeyNote`, which returned its input unchanged.
- 9cd555b: The plugin that provides `clientAuth` describes the credential an app sends in `cli.clientCredential`: its label, header, environment variable, and how to generate and provision it. `@hot-updater/server/db` exports `clientAuthOf`, `generateClientCredential`, and `provisionClientCredential`, which read it from a plugin list.

  Managed init provisions the app's credential through the provider's plugins and prints `HotUpdater.init` with that credential's header, or with no `requestHeaders` when client routes are public; `@hot-updater/cli-tools` exports `renderAppSetup` and `printAppSetup` for it. AWS CloudFront cache and origin-request policies key on the client-route policy's `varyHeaders` instead of a fixed `x-api-key`.

  Agent and infrastructure scaffolds record the server's `clientAuth` in `manifest.json` and render their instructions from it. The helper is `app/provision-client-credential.mjs` with `app/database.config.ts`, and it saves `app/client-credential.local`. `hot-updater doctor` reads the credential's header and variable from the scaffold, and skips the 401 check when client routes are public.

- 9cd555b: A server plugin names the client plugin an app adds to `HotUpdater.init`'s `plugins` in `cli.clientPlugin`, as `{ module, name }`; `insights()` names `insights` from `@hot-updater/react-native/plugins/insights`. `createHotUpdater` checks them at startup: each names an export the app can import, not a reserved word, `App`, or `HotUpdater`, and no two plugins name one export from different modules. `@hot-updater/server/db` exports `clientPluginsOf`, which reads them from a plugin list. Managed init passes them to `printAppSetup`, which imports them and adds them to `plugins`, and agent scaffolds record them in `manifest.json` and render the app code in their instructions from them.

### Patch Changes

- Updated dependencies [e696e69]
- Updated dependencies [1ddd5fc]
- Updated dependencies [9a6715f]
- Updated dependencies [530cca5]
  - @hot-updater/plugin-core@1.0.0-rc.17

## 1.0.0-rc.16

### Minor Changes

- fe03f59: Move the CLI onto core's API, add admin API protocol 2 for self-hosted servers, and generate `hotUpdater.plugins.ts` on init.
  - **CLI on core:** `deploy`, `patch`, `promote`, `catalog`, `storage prune`, artifact deletion, and the bundle commands read and write through core's API. Reads are keyset pages through declared indexes, and writes are typed operations. The CLI opens core in process on the database's storage engine, or through `standaloneRepository` for a self-hosted server.
  - **Deploy:** before anything is built or uploaded, `deploy` checks the database: the schema fence, or a self-hosted server's admin protocol. Each bundle, its patches, its release, and the next catalog of each scope are written in one core call.
  - **Auto-patch bases:** bases come from one point read of the new bundle's Release Catalog scope. A base is an older bundle whose enabled release, in the same channel and platform, has the same fingerprint or an app version range intersecting the target's, newest release first, up to `maxBaseBundles`.
  - **Release lists:** they read the narrowest index the filters allow (bundle, channel and platform, or all) and filter the other fields in the CLI.
  - **`hotUpdater.core`:** it now has core's typed operations next to its reads: deploy, release policy changes and their preflight, promotion, release deletion, catalog rebuilds, channels, and bundle updates and deletes. On the storage engine, the admin handler writes through them.
  - **Admin API protocol 2:** `/version` reports `adminProtocol: 2` and is also served by the admin handler. The list routes page by key (`cursor`, `limit`, `order`) and take the indexed filter sets; `v=2` is accepted and changes nothing. New routes: `POST /releases`, `POST /releases/:id/promote`, `POST /release-catalogs/:scopeKey/preflight`, `POST /bundles/delete`, `GET /bundles/:id/children`, and `GET /base-candidates/:candidateKey`.
  - **`standaloneRepository`:** its `core` is core's API over protocol 2. The first call checks `/version`, so an older server fails with a message to upgrade `@hot-updater/server`. A 503 from the server's schema fence names `hot-updater db migrate`.
  - **`hot-updater init`:** for AWS, Cloudflare, Firebase, and Supabase, init writes `hotUpdater.plugins.ts` next to `hot-updater.config.ts`. It re-exports the provider's `plugins`, the list the managed server runs. An edited file is kept. The agent scaffolds include the file.
  - **`hot-updater api-key`:** it manages keys through the config's `apiKeys()` plugin, and refuses a config without it.

- 8d60f68: Move the console onto core's API: key cursors, indexed filter sets, counters, and a banner when Insights is off.
  - **Bundles:** the list pages by key, with Previous, Next, and Newest in place of page numbers. Each page reads only its own releases.
  - **Filters:** the filters are the sets the release indexes serve: a channel with its platform (and status), an artifact, or a target, which is one catalog scope. The platform filter works with a channel, and the target app version filter is replaced by "Show bundles for this target" in a bundle's diagnostics.
  - **Counters:** patch counts and a bundle's children come from its reference counter and the patches index, not from paging every bundle. Bundle totals come from one counter row.
  - **Core:** bundles, releases, catalogs, and channels go through core's API: in process on the database's storage engine, or over a self-hosted server's admin API protocol 2. Creating a channel takes its name. A database that is not on the storage engine is refused with a message to upgrade its provider.
  - **Insights off:** when the server runs without `insights()`, the Insights pages and bundle panels show that Insights is off instead of an error. A self-hosted server is asked through its admin API, which answers 204 with `x-hot-updater-insights: disabled`. The console reads a self-hosted server's events and installations there. Usage and bundle activity need the database config.
  - **Plugins in the console:** `defineConsoleConfig({ plugins })` and a project's `hotUpdater.plugins.ts`, which `hot-updater console` loads, give the console the plugins the server runs. It assembles them over the database with `createDatabasePluginApis` from `@hot-updater/server/db`, on the server's tables. Without them, Insights and API keys are off.
  - **API keys:** the console manages keys through the `apiKeys()` plugin's API. It does not manage a self-hosted server's keys.
  - **`standaloneRepository`:** it has `fetchAdmin(path)`, a GET on the server's admin handler with the repository's headers.
  - **`@hot-updater/cli-tools`:** it adds `loadHotUpdaterPlugins`.

### Patch Changes

- 228b6c7: Remove the legacy database contract. Every database runs on the storage engine, and core, its plugins, and the admin API are the only way to its data. Release candidate databases are recreated, not converted.
  - **Databases:** a provider returns an `EngineDatabase`, `{ name, adapter, dispose? }`, with `provider`, `createMigrator`, and `generateSchema` for `hot-updater db` where it has them. `createEngineDatabase({ name, adapter })` from `@hot-updater/server/database` puts the adapter behind the schema fence with the built-in settings; `builtInSchema`, `builtInSettings`, and `migrateBuiltInSchema` are the built-in tables, their settings rows, and their migration. `DatabasePlugin`, `createDatabasePlugin`, `createDatabaseClient`, the model and commit types, `commitReleaseCatalogMutation(s)`, and `BundleRepository` are gone.
  - **`createHotUpdater`:** takes `{ database, storage?, plugins?, clientAccess? }`; `plugins` defaults to none. `clientAccess` is `"public"`, or absent when a plugin provides clientAuth. A `clientAccess` object is a type error whose message names `apiKeys()`, and at startup a `HotUpdaterConfigError` that names it too. The instance is `{ handlers, core, api, adapterName }`: bundle, channel, release, Insights, and API key methods on it are gone; use `core` and the plugins' `api`. `registerApiKey`, `createApiKey`, `provisionApiKey`, and `createHandlers` are no longer exported; the `apiKeys()` plugin's API does the same work.
  - **Handlers:** client routes read catalogs and artifacts through core. The admin API speaks protocol 2 only: `v=2` is accepted and changes nothing, and `POST /database/commit`, `POST /bundles`, and `DELETE /bundles/:id` are gone (deploy with `POST /releases`, delete with `POST /bundles/delete`). `PATCH /bundles/:id` answers 204. The Insights routes come from `insights()`; without it they answer 204 with `x-hot-updater-insights: disabled`.
  - **Schema:** generated SQL, Drizzle, and Prisma schemas have no database foreign keys; the engine keeps references. CockroachDB and SQL Server are no longer supported, and `relationMode` is gone. The checked-in Postgres and Supabase SQL is regenerated.
  - **Providers:** `postgres`, `d1Database`, `supabaseDatabase`, `firebaseDatabase`, and `dynamoDB` return engine databases. `dynamoDB` invalidates the cached update-check routes after a write that changes a Release Catalog.
  - **`standaloneRepository`:** is `{ name, core, fetchAdmin }` over admin API protocol 2; its protocol 1 reads and custom bundle `routes` are gone.
  - **`@hot-updater/test-utils`:** `setupDatabaseTestSuite` runs core, bundles, the Release Catalog contract, and Insights through admin API protocol 2 over HTTP, and with `createInsightsModel` the Insights report contract. It replaces `setupDatabasePluginTestSuite` and `setupDatabaseClientTestSuite`. `setupBundleMethodsTestSuite` and `setupReleaseCatalogTestSuite` take `{ getClient }` on protocol 2.
  - **CLI and console:** they read and write through core only. `hot-updater api-key` manages keys through the config's `apiKeys()` plugin, and the console runs the config's `plugins`: without them, Insights and API keys are off.

- Updated dependencies [d482b13]
- Updated dependencies [d482b13]
- Updated dependencies [fe03f59]
- Updated dependencies [d482b13]
- Updated dependencies [2431c0a]
- Updated dependencies [ad00722]
- Updated dependencies [d482b13]
- Updated dependencies [d482b13]
- Updated dependencies [f6ffb68]
- Updated dependencies [c68e9f3]
- Updated dependencies [065c457]
- Updated dependencies [8a03eb2]
- Updated dependencies [aee193e]
- Updated dependencies [228b6c7]
- Updated dependencies [065c457]
- Updated dependencies [df31037]
  - @hot-updater/plugin-core@1.0.0-rc.16

## 1.0.0-rc.15

### Patch Changes

- 79c3eea: Use the versioned manifest artifact protocol for every OTA install. Deploys
  publish a manifest, content-addressed files and one tar.br bulk transport. The
  native installer reuses byte-identical built-in assets and compares tar.br with
  the remaining transfer cost. Complete downloads without patches may additionally
  allow the signed TAR framing overhead to avoid request fanout. Failed archives
  fall back once to verified original files; failed patches recover per file.

  Remove `compressStrategy`, ZIP/gzip OTA extraction, format detection and archive
  strategy branches. Archive identity and bounds belong to the signed manifest;
  Bundle and provider rows stay manifest-based. The unreleased 1.0.0 schema and
  initial migrations now require manifest metadata directly.

  Validate complete descriptor sets before reuse, recheck cached target files,
  and retain hash-verified staging files across retries. Download remaining files
  with a fixed concurrency limit and report only network files in download progress.

  Allow concurrent Supabase deploys to upload the same shared content-addressed
  asset without failing on an already-existing object.

  Authenticate the versioned artifact endpoint. Preserve installed bundles across
  promotion failures and interrupted renames, and require durable metadata before
  activating an OTA. Remove manifestless launch and BUNDLE_ID compatibility paths,
  unused native progress fields, observers, and unused iOS task-state persistence.

- d99530b: Stop installing dotenv during init. Generate configs with Node's built-in environment loader, allow CI to supply environment variables without a local env file, and preserve existing environment setup when merging configs.

  Use Node's native environment parser for server verification and remove dotenv from generated infrastructure dependency lists and API-key configs.

  Remove direct dotenv dependencies from examples and server examples, replace react-native-dotenv in mobile examples with explicit public configuration, and update the documentation. Preserve public E2E build settings for manual launches.

- Updated dependencies [f5fffea]
- Updated dependencies [79c3eea]
  - @hot-updater/plugin-core@1.0.0-rc.15
  - @hot-updater/core@1.0.0-rc.15

## 1.0.0-rc.14

### Patch Changes

- Align all Hot Updater packages on 1.0.0-rc.14 for a coordinated release candidate. Future releases continue to use independent package versions.
- b23db5e: Replace shared Insights installation storage with canonical events and provider-private indexes for current installation queries. SQL and MongoDB keep nine access fields and fetch full event payloads only for selected results; DynamoDB counts compact scope entries. Custom providers implement `recordEvent({ event })`, `findLatestEvents`, and explicit `countLatestEvents` predicates without lifecycle helpers. Move ancillary event fields into typed `metadata`, reusing Bundle JSON conventions, while preserving SDK requests and Console responses.

  This changes the unreleased 1.0.0 initialization and custom database contract from the previous installation-row design. The read-cost fix preserves the canonical-event contract and keeps current-state queries independent of retained event history. Append and index updates are atomic; measured read/write costs are documented.

- Updated dependencies [479c1e5]
- Updated dependencies
- Updated dependencies [b23db5e]
  - @hot-updater/plugin-core@1.0.0-rc.14
  - @hot-updater/core@1.0.0-rc.14

## 1.0.0-rc.3

### Patch Changes

- Updated dependencies [663d8e9]
  - @hot-updater/plugin-core@1.0.0-rc.3

## 1.0.0-rc.2

### Patch Changes

- 51300d4: Define the required Insights persistence contract as `record`, `listEvents`,
  object-based `findInstallations`, `countInstallations`, and `countEvents`. Core
  owns report preparation, filters, windows, cursors, and summaries; providers
  implement atomic report/latest-state storage, fixed indexed queries, and scalar
  counts. Duplicate event IDs are first-write-wins and never update installation
  state again.

  Add scoped recent-reporting counts and selected-bundle applied, recovered-from,
  and adopted report counts with matching event drill-down in Console. Recovery
  from B to A belongs to B's recovery count while latest state names A. Counts
  remain independent live measurements and do not claim an exact share or success
  rate.

  Include all Insights indexes and native writers in the initial `1.0.0` schema.
  MongoDB Insights requires native transactions on a replica set or sharded
  cluster. Regenerate standalone ORM schemas and apply emitted Prisma collation
  SQL where required.

  Prisma SQL Server Insights explicitly rejects before database I/O because its
  string identity/order semantics do not meet this contract; other models remain
  available. MongoDB counts require version 5+ snapshot reads.

- 590ca70: Upload non-archive files with `application/octet-stream` instead of `application/zip`. `getContentType` fell through to the compression format table for any name `mime` did not resolve, and that table defaults to zip, so brotli bundle assets (`.br`), extensionless content addressed assets, and `.bsdiff` patches were all mislabeled by the CLI storage upload helper.
- a837c71: Upgrade verkit to 0.4.0 while preserving canonical app-version strings and
  Doctor's package-version compatibility checks with the new parsed SemVer
  return values. Upgrade the workspace build tool tsdown to 0.22.14.
- Updated dependencies [51300d4]
- Updated dependencies [590ca70]
- Updated dependencies [a837c71]
  - @hot-updater/plugin-core@1.0.0-rc.2

## 1.0.0-rc.1

### Minor Changes

- 6d0cdc7: Rename the built-in Analytics domain to Insights across the database model,
  server provider and HTTP query route, React Native option and transport,
  Console route and UI, and provider contracts. This is a breaking pre-release
  rename with no compatibility aliases; use `database.models.insights`,
  `createInsightsProvider`, `/bundles/:id/events/insights`, and `insights`.

  Enable React Native Insights reporting by default for both `HotUpdater.init`
  and `HotUpdater.wrap`. Set `insights: false` to opt out.

### Patch Changes

- 8145d48: Separate bundle signer identity from the native trust anchor. Signing providers
  now expose public identity only through `getPublicKey()`, while Expo reads its
  public trust-anchor file exclusively from the app config plugin and includes it
  in native fingerprints. Add public-key materialization for Expo and validate
  Expo CNG trust anchors during deploy and doctor without loading signing
  credentials during prebuild.
- Updated dependencies [6d0cdc7]
- Updated dependencies [8145d48]
  - @hot-updater/plugin-core@1.0.0-rc.1

## 1.0.0-rc.0

### Major Changes

- adb0e40: Release HotUpdater 1.0 with the Release Catalog architecture.

### Minor Changes

- 3b367e7: Add built-in API key authentication backed by the official
  `database.models.apiKeys` domain. Every `createHotUpdater` call must set
  `clientAccess` explicitly. `{ type: "api-key" }` protects OTA reads and
  Analytics ingestion with `x-api-key` by default; it does not grant Analytics
  query, Bundle management, or API key management access.

  Add `hot-updater api-key create`, `list`, and `revoke` for self-hosted
  deployments. Creation returns the plaintext API key exactly once, while the
  database stores only its SHA-256 hash and non-secret metadata. Managed AWS,
  Cloudflare, Firebase, and Supabase init use the same API key domain and persist
  the plaintext only in the local `HOT_UPDATER_API_KEY` environment entry.
  Console API key management uses the same domain directly.
  `createHotUpdater(...).apiKeys` exposes the common local create, list, and
  revoke management API without adding an HTTP management route.
  Self-hosted setup now recommends the `api-key` client policy: migrate the direct
  database, create a key from the same config, then pass the one-time plaintext to
  React Native through `x-api-key`. The `public` policy remains an explicit
  unauthenticated alternative.

  Rename the pre-release public API and storage terminology from Client Access
  Key to API Key, including `database.models.apiKeys`, `ApiKeyModel`,
  `ApiKeyRow`, `createApiKey`, and `registerApiKey`. Fresh v1 provider schemas use
  the canonical API key naming and do not migrate or reuse v0 databases.

  Remove the separate Better Auth package, generic authentication provider,
  managed route policy, universal component schema, and provisioning preset.

- b424d47: Replace the legacy database plugin API with the fixed official-domain contract:

  ```ts
  createDatabasePlugin({
    name,
    models: {
      bundles,
      bundlePatches,
      releases,
      releaseCatalogs,
      channels,
      analytics,
      apiKeys,
    },
    commit,
    dispose,
  });
  ```

  Provider callback transactions, generic CRUD, factories, runtime contexts,
  capability registries, `commitBatch`, and the former top-level model and query
  members are no longer public. `commit({ changes })` is now a declarative,
  ordered, atomic write boundary across every official model. Expected missing-row
  and live-reference conflicts identify the original change index; failed commits
  roll back all earlier changes. Providers without a suitable atomic primitive
  reject a multi-change commit before its first write.

  Add Channels as a normalized, persistent model with opaque `id` and exact,
  case-sensitive `name`. Channel IDs and names are non-empty and limited to 255
  Unicode code points. Releases reference `channel_id`; immutable Bundle rows do
  not carry Channel or delivery-policy fields. Channel listing reads the Channel
  model directly instead of scanning Bundles. Channels remain after their last
  Release is removed and can be deleted explicitly only when no Release references
  them.

  Schema `1.0.0` creates Channel, Bundle, Bundle patch, Release, Release Catalog,
  Analytics, and API key storage on an empty database. It rejects v0
  schema markers and does not backfill Bundle policy. Kysely, Drizzle, Prisma,
  MongoDB, Cloudflare D1, PostgreSQL, Supabase, Firebase, DynamoDB, and Mock
  implement the same logical contract.

  Add mount-relative Channel admin routes: `GET /channels`, `POST /channels`, and
  empty-only `DELETE /channels/:id`. With the recommended mount these are exposed
  under `/hot-updater/admin/channels`. Remove the legacy
  `/api/bundles/channels` route. Standalone remains a narrower remote
  `BundleRepository`, while self-hosted `createHotUpdater` owns the full database
  contract. The Console can create Channels and request safe deletion; a concurrent
  Release reference is reported as `not_empty` without losing data.

  Official providers implement the fixed access patterns used by the shared
  client: exact domain filters, id ordering, bounded pagination, row counts,
  patch lookup by owner IDs, exact Catalog reads, strongly consistent Release
  scope reads, and atomic ordered changes across official models. Provider-owned
  update selection and arbitrary distinct, projection, connector, and
  string-comparison query DSL operations are no longer part of the public
  database plugin contract. Cloudflare D1 rejects malformed count results instead
  of returning zero.

  The shared database client resolves the canonical Channel row before Release
  writes and compiles affected Catalogs in the same atomic commit. The v0
  `queries.getUpdateInfo` optimization and combined Bundle-policy writes are
  removed. `@hot-updater/test-utils` publishes conformance coverage for all-model
  commits, rollback, Channel persistence, canonical concurrent inserts, safe
  deletion, and the absence of bundle-scan Channel reads.

  Runtime-specific composition entrypoints keep the same provider names behind
  explicit package subpaths. `@hot-updater/cloudflare/worker` accepts a native D1
  binding through `d1Database(database)`, while `@hot-updater/supabase/edge`
  exports the Edge-compatible `supabaseDatabase` and `supabaseStorage`. Root
  entrypoints remain the configuration-time providers.

  Self-hosted runtimes always expose Analytics ingestion and query capabilities
  backed by `database.models.analytics`. Every `createHotUpdater` call explicitly
  sets the required `clientAccess` policy, which can protect update checks and
  Analytics ingestion through
  `database.models.apiKeys`. Client update routes are always available
  on `handlers.client`, while admin routes are exposed only by explicitly
  mounting `handlers.admin`. The CLI-only
  `standaloneRepository` stays a bundle repository; the physical database passed
  to the self-hosted `createHotUpdater` instance owns the full official contract.

- 5a2e1cd: Separate immutable Bundle artifacts from mutable Release policy and compile
  policy changes ahead of time into deterministic Release catalogs.
  Database plugins now expose Release and catalog models plus atomic Release
  revision/catalog generation expectations, and no longer expose provider update
  decision queries.

  Add canonical v2 Release-catalog and Bundle-artifact routes, short-lived
  authenticated shared caching, a v1-only device protocol boundary, Release
  management commands, catalog preflight/rebuild tooling, and a familiar Bundle
  management view backed by Releases. The Console keeps Bundle content, delivery settings,
  promote, and download actions in one workflow while Release identity stays
  secondary. Deploy and promote create Releases; rollback disables the current
  Release so clients select the previous compatible enabled Release or the
  built-in app. Rollout, targeting, enablement, and messages mutate Releases
  while patch, manifest, signing, and storage behavior remain Bundle-keyed.
  Release IDs are canonical UUIDv7 values. Console shadcn primitives now use Base
  UI instead of Radix while preserving the existing management flow and visual
  density.

  React Native clients select desired Releases locally, persist authority/scope
  generation high-water and full Release/Bundle receipts, support same-Bundle
  adoption and authenticated BUILTIN fallback, and use generation/context CAS so
  stale artifact work cannot commit. New catalogs retain an 11-artifact update
  frontier plus the complete compatible enabled rollback spine, so rollback keeps
  v0 predecessor semantics even for old active clients. The 256 KiB catalog cap
  remains atomic: an oversized history rejects the Release mutation instead of
  silently truncating rollback candidates. Analytics events now carry directional
  Release identity alongside Bundle identity.

  Migrate SQL, DynamoDB, D1, Firestore, Supabase, MongoDB, Drizzle, Kysely,
  Prisma, Standalone, mock, and in-memory implementations to schema `1.0.0`.
  Managed AWS and Cloudflare deployments place Release catalogs behind their
  supported pre-origin cache. Firebase and Supabase use their direct Function
  URLs as supported origin-only modes and report Function invocations separately
  from database catalog reads.

- e2455c5: Remove user-managed Catalog authority from configuration, generated provider
  environments, deployment output, and public React Native update state. Catalogs
  receive an opaque identity on their first atomic commit and preserve it across
  updates, rebuilds, and tombstones. CLI and server share the persisted identity
  without configuration. Native stale-generation and unexpected-Catalog guards
  remain in place.

  This changes the unreleased v1 database schema and internal JS/native protocol
  together. Catalog rows are part of persistent history and must be included in
  backups; a missing row with retained Releases cannot be regenerated safely.

- c8e24cd: Make Hot Updater v1 infrastructure a clean generation boundary. Managed init
  now rejects selected v0 compute resources before mutation. Supabase tables and
  RPCs plus Firebase collections and Functions use fixed v1 namespaces, allowing
  v0 and v1 to coexist in one project while doctor identifies missing generation
  markers and gives the parallel-cutover remediation.

  AWS fresh installs use v1 Lambda and DynamoDB names plus a Lambda-scoped v1
  signing-key path. S3 buckets can be shared across generations: init no longer
  treats a matching bucket origin as CloudFront ownership, creates a new
  distribution by default, and only updates the exact saved distribution after
  its generation check passes.

  Remove the v0 app-version and fingerprint HTTP routes, the legacy SDK-version
  header contract, CDN forwarding and cache paths for those routes, and managed
  provider Release Catalog backfills. Existing v0 native binaries must remain on
  their unchanged v0 endpoint; new v1 native builds use the unversioned catalog
  and artifact routes on fresh v1 infrastructure.

  Normalize managed provider base URLs to their public deployment roots. AWS,
  Cloudflare, and Firebase now serve `/version`, `/release-catalogs/*`,
  `/artifacts/*`, and `/events` directly; Supabase retains only its
  provider-owned Edge Function prefix. Client routes do not carry a library or
  protocol version prefix because incompatible generations use a fresh base URL.

- 25af6ef: Replace runtime-profiled storage plugins with the flat, runtime-independent
  `createStoragePlugin({ name, protocol, put, get, getDownloadUrl, exists, delete
})` contract. Every operation uses an object input and object result. `put`
  accepts a complete object key and a one-shot Web stream, `get` returns a Web
  `Response`,
  `getDownloadUrl` returns the URL sent to update clients, and `delete` always
  targets exactly one object and resolves to the idempotent `{ deleted: true }`
  postcondition. Remove file paths, factory thunks, runtime contexts, prefix
  deletion, and lifecycle hooks from the core storage boundary.

  Standardize persisted locations as hierarchical
  `protocol://bucket/encoded/slash/key` URIs. `createStorageUri` encodes each key
  segment without flattening slash hierarchy, while `parseStorageUri` performs
  the matching validation and decoding. Empty and dot segments, query strings,
  and fragments are rejected.

  Pass server storage implementations directly through
  `createHotUpdater({ storage: [...] })`. URL policy belongs to each storage
  implementation: AWS S3 can use its CloudFront resolver or a server-signed URL,
  Firebase and Supabase generate provider URLs, and private Cloudflare R2 returns
  a signed handler-relative URL. Remove `storageDelivery`, public base-URL and
  top-level signing-key configuration, and the separate provider delivery
  helpers. Cloudflare Worker storage uses the same `r2Storage` export name from
  the `/worker` subpath and captures its native R2 binding at construction.

  Resolve persisted URIs by registered scheme ownership first, including `http`
  and `https`. Only an HTTP(S) URI without an owner uses direct fetch or redirect;
  other unowned schemes are unsupported. Runtime composition accepts at most one
  storage plugin for each scheme.

  Update every built-in storage provider, CLI and Console consumer, managed
  runtime, package entrypoint, and custom-hosting guide to the new contract.
  Remove the storage-only JWT URL helpers and obsolete runtime-specific storage
  creators. Route-group flags are removed; Analytics is always available and the
  required `clientAccess` policy controls client authentication.

- 7ec1a46: Persist required immutable archive and patch byte sizes across the initial v1
  Bundle contract and official database providers. This pre-release change has no
  general cross-provider backfill for earlier unreleased `1.0.0` schemas. DynamoDB
  readers default a missing archive byte size on existing Bundle rows to zero,
  while Cloudflare applies an incremental D1 migration that backfills missing
  Bundle and patch byte sizes with zero.

  Record optional exact served-object sizes and hashes in Bundle manifests,
  content-address new Brotli payloads by their compressed hash, and let the
  server select the archive when known normal diff bytes are equal to or larger
  than it. Unknown optional manifest metadata preserves the existing
  manifest-first path, with no native protocol change or request-time storage
  metadata probe.

### Patch Changes

- 3b367e7: Prevent managed init from overwriting existing v0 Workers and Functions when
  the selected compute resource name is already in use. Retry initial AWS Lambda
  creation while a newly created execution role propagates. Show the issued API
  key separately after the React Native setup example so it can be stored safely.
  Enable the Cloud Functions API before checking an existing Firebase function
  and report function discovery failures without an unhandled command stack.
  Bundle Firebase Functions' internal plugin dependency and deploy only the
  managed v1 Function target so an existing v0 Function is preserved.
  Wait for a newly provisioned Supabase Storage tenant before creating the
  selected bucket, and preserve the access level of a reused operator-owned
  bucket. Wait for PostgREST to expose newly migrated Supabase tables before
  registering the init API key, and keep Supabase CLI metadata inside the
  temporary scaffold workdir.
- a9ffb2a: Remove unused `releaseChannel` from `hot-updater.config.ts`. The build-time channel is set with `hot-updater channel set`.
- a9ffb2a: Require R2 S3 credentials, drop Wrangler `r2Storage` and Android `stringResourcePaths`. Doctor only targets infrastructure generation 1.0.0. Channel, fingerprint, and signing keys live in AndroidManifest.xml.
- c355c26: Extend Bundle Signing with plugins for a generic remote signing endpoint, AWS
  KMS, and Google Cloud KMS while preserving v0 local `enabled`/`privateKeyPath`
  configuration. Local `publicKeyPath` is optional; signing plugins require it.
  Support public-key-only native/Expo builds and sanitized read-only Console
  inspection. Local PEM is the standard baseline, while AWS KMS and Google Cloud
  KMS provide hardened, non-exportable key custody through optional SDK peers.

  Require RSA keys of at least 2048 bits, validate explicit public-key pins and
  native key matches before deployment, and verify signatures before upload.
  Prevent key generation from overwriting existing files and default to
  cancelling replacement of a different or invalid embedded public key. Existing
  v0 CLI-generated keys meet the key requirements; signing-key changes still
  require a native-first rollout.

- a9ffb2a: Remove leftover v0 aliases that are not field compatibility. `HotUpdater.wrap({ updateMode: "manual" })` throws, findMany accepts only `orderBy`, and Supabase plugins require `supabaseServiceRoleKey`. Managed init still detects leftover `supabaseAnonKey` so skipped v0 configs fail closed.
- Updated dependencies [3b367e7]
- Updated dependencies [b424d47]
- Updated dependencies [9650748]
- Updated dependencies [88c163a]
- Updated dependencies [a9ffb2a]
- Updated dependencies [a9ffb2a]
- Updated dependencies [5a2e1cd]
- Updated dependencies [adb0e40]
- Updated dependencies [e2455c5]
- Updated dependencies [25af6ef]
- Updated dependencies [c355c26]
- Updated dependencies [7ec1a46]
- Updated dependencies [a9ffb2a]
  - @hot-updater/plugin-core@1.0.0-rc.0
  - @hot-updater/core@1.0.0-rc.0

## 0.36.0

### Patch Changes

- 9759e8a: Reduce S3 management query work by skipping legacy UUIDv7 artifact traversal, deriving channels from canonical manifest keys, and batching multi-bundle deletion scans and commits. Store new bundle artifacts below `bundles/<bundle-id>` while preserving legacy reads, and add exact target app version filters to the CLI and Console. Add an exclusive-maintenance `hot-updater storage prune` command for orphaned bundle objects and unreferenced shared assets, with an explicit `--dry-run` candidate table, a recent-object protection window, and fail-closed reference validation safeguards.
- Updated dependencies [9759e8a]
  - @hot-updater/plugin-core@0.36.0
  - @hot-updater/core@0.36.0

## 0.35.12

### Patch Changes

- fd30452: Support firebase-admin v14 by using the modular Admin SDK APIs.
- 6e8b32e: Replace the semver dependency with verkit.
- Updated dependencies [6e8b32e]
  - @hot-updater/plugin-core@0.35.12
  - @hot-updater/core@0.35.12

## 0.35.11

### Patch Changes

- Updated dependencies [1a3a621]
  - @hot-updater/plugin-core@0.35.11
  - @hot-updater/core@0.35.11

## 0.35.10

### Patch Changes

- ce8d254: feat: support platform-scoped `fingerprint.extraSources`

  `fingerprint.extraSources` now accepts `{ ios?: string[], android?: string[] }`
  in addition to `string[]`. An array keeps the existing behavior (shared by both
  platforms); the object form only feeds the fingerprint of the platform it is
  scoped to, so an iOS-only native input no longer moves the Android fingerprint
  (and vice versa).

  The default config no longer sets `extraSources: []`, which the config deep
  merge would otherwise use to clobber a user-supplied object.

- Updated dependencies [ce8d254]
  - @hot-updater/plugin-core@0.35.10
  - @hot-updater/core@0.35.10

## 0.35.9

### Patch Changes

- 8688b1a: chore: migrate to TypeScript 7 and OXC
- f9bb26d: Declare init inputs in each provider package through a shared contract, ask
  once before saving credential inputs, and support prompt-free infrastructure
  reconciliation with `init --env-file .env.hotupdater`.
  - @hot-updater/core@0.35.9
  - @hot-updater/plugin-core@0.35.9

## 0.35.8

### Patch Changes

- 4f9fab2: Render spinner, progress, and task output statically in CI and non-interactive
  terminals, and update the embedded Clack runtime to 1.7.0.
  - @hot-updater/core@0.35.8
  - @hot-updater/plugin-core@0.35.8

## 0.35.7

### Patch Changes

- @hot-updater/core@0.35.7
- @hot-updater/plugin-core@0.35.7

## 0.35.6

### Patch Changes

- @hot-updater/core@0.35.6
- @hot-updater/plugin-core@0.35.6

## 0.35.5

### Patch Changes

- @hot-updater/core@0.35.5
- @hot-updater/plugin-core@0.35.5

## 0.35.4

### Patch Changes

- @hot-updater/core@0.35.4
- @hot-updater/plugin-core@0.35.4

## 0.35.3

### Patch Changes

- @hot-updater/core@0.35.3
- @hot-updater/plugin-core@0.35.3

## 0.35.2

### Patch Changes

- @hot-updater/core@0.35.2
- @hot-updater/plugin-core@0.35.2

## 0.35.1

### Patch Changes

- @hot-updater/core@0.35.1
- @hot-updater/plugin-core@0.35.1

## 0.35.0

### Patch Changes

- @hot-updater/core@0.35.0
- @hot-updater/plugin-core@0.35.0

## 0.34.0

### Patch Changes

- Updated dependencies [088f6c1]
- Updated dependencies [7244b65]
  - @hot-updater/plugin-core@0.34.0
  - @hot-updater/core@0.34.0

## 0.33.2

### Patch Changes

- @hot-updater/core@0.33.2
- @hot-updater/plugin-core@0.33.2

## 0.33.1

### Patch Changes

- Updated dependencies [a5c4467]
  - @hot-updater/plugin-core@0.33.1
  - @hot-updater/core@0.33.1

## 0.33.0

### Patch Changes

- 070a86f: Fix copied bundle promotion to upload Brotli Hermes bundle assets expected by manifest-driven update checks.
- Updated dependencies [e914f56]
  - @hot-updater/plugin-core@0.33.0
  - @hot-updater/core@0.33.0

## 0.32.0

### Patch Changes

- 4e6d2ec: Use deterministic content-addressed storage keys for manifest assets, require storage plugins to implement object existence checks, skip uploads when the object already exists, limit deploy upload concurrency, stream hashing/compression work to reduce memory pressure, and report upload progress through 100%.
- Updated dependencies [4e6d2ec]
  - @hot-updater/plugin-core@0.32.0
  - @hot-updater/core@0.32.0

## 0.31.4

### Patch Changes

- @hot-updater/core@0.31.4
- @hot-updater/plugin-core@0.31.4

## 0.31.3

### Patch Changes

- @hot-updater/core@0.31.3
- @hot-updater/plugin-core@0.31.3

## 0.31.2

### Patch Changes

- @hot-updater/core@0.31.2
- @hot-updater/plugin-core@0.31.2

## 0.31.1

### Patch Changes

- @hot-updater/core@0.31.1
- @hot-updater/plugin-core@0.31.1

## 0.31.0

### Patch Changes

- Updated dependencies [5b0a0f5]
- Updated dependencies [5b0a0f5]
  - @hot-updater/core@0.31.0
  - @hot-updater/plugin-core@0.31.0

## 0.30.12

### Patch Changes

- @hot-updater/plugin-core@0.30.12

## 0.30.11

### Patch Changes

- @hot-updater/plugin-core@0.30.11

## 0.30.10

### Patch Changes

- @hot-updater/plugin-core@0.30.10

## 0.30.9

### Patch Changes

- @hot-updater/plugin-core@0.30.9

## 0.30.8

### Patch Changes

- 6019156: refactor(cli-tools): extract `promoteBundle` from `@hot-updater/console` so it can be reused by the CLI

  `promoteBundle` and `createCopiedBundleArchive` move from `@hot-updater/console`'s server-only `lib/server/promoteBundle.ts` into `@hot-updater/cli-tools`. The console's RPC handler now imports from `@hot-updater/cli-tools`. UUIDv7 helpers (`createUUIDv7`, `extractTimestampFromUUIDv7`, `createUUIDv7WithSameTimestamp`) move to `@hot-updater/plugin-core` since they are generic primitives, not console-specific.

  Pure refactor — no behavior change. Existing test coverage moves with the function. This unblocks an upcoming `hot-updater promote` CLI command that calls the same implementation as the console UI.

- Updated dependencies [6019156]
  - @hot-updater/plugin-core@0.30.8

## 0.30.7

### Patch Changes

- 03fd179: Run the `hot-updater` CLI from native ESM on Node 20 so TypeScript config
  files load through ESM import conditions.

  Require Node.js 20.19.0 or newer for the CLI package surface.

  Run the `hot-updater` CLI bin from the native ESM entrypoint and stop emitting
  a CommonJS build for the CLI entry.

  Bump the `hot-updater` CLI package's vulnerable `kysely` and
  `fast-xml-parser` dependency entries to patched versions without pnpm
  overrides.
  - @hot-updater/plugin-core@0.30.7

## 0.30.6

### Patch Changes

- @hot-updater/plugin-core@0.30.6

## 0.30.5

### Patch Changes

- @hot-updater/plugin-core@0.30.5

## 0.30.4

### Patch Changes

- @hot-updater/plugin-core@0.30.4

## 0.30.3

### Patch Changes

- @hot-updater/plugin-core@0.30.3

## 0.30.2

### Patch Changes

- @hot-updater/plugin-core@0.30.2

## 0.30.1

### Patch Changes

- @hot-updater/plugin-core@0.30.1

## 0.30.0

### Minor Changes

- 83c01c8: fix: keep target cohorts additive to rollout

### Patch Changes

- Updated dependencies [83c01c8]
  - @hot-updater/plugin-core@0.30.0

## 0.29.8

### Patch Changes

- @hot-updater/plugin-core@0.29.8

## 0.29.7

### Patch Changes

- @hot-updater/plugin-core@0.29.7

## 0.29.6

### Patch Changes

- 80cce61: feat(cli): merge init config on re-run
  - @hot-updater/plugin-core@0.29.6

## 0.29.5

### Patch Changes

- Updated dependencies [52208f4]
  - @hot-updater/plugin-core@0.29.5

## 0.29.4

### Patch Changes

- @hot-updater/plugin-core@0.29.4

## 0.29.3

### Patch Changes

- Updated dependencies [d1ffb83]
  - @hot-updater/plugin-core@0.29.3

## 0.29.2

### Patch Changes

- 2a1bc80: fix: node deps bundling
  - @hot-updater/plugin-core@0.29.2

## 0.29.1

### Patch Changes

- @hot-updater/core@0.29.1
- @hot-updater/plugin-core@0.29.1

## 0.29.0

### Minor Changes

- a935992: feat: Rollout feature with control from 1% to 100%

### Patch Changes

- d0fe908: fix(console): rebuild copied bundles with fresh uuidv7 ids
- Updated dependencies [a935992]
- Updated dependencies [d0fe908]
  - @hot-updater/plugin-core@0.29.0
  - @hot-updater/core@0.29.0

## 0.28.0

### Patch Changes

- @hot-updater/core@0.28.0
- @hot-updater/plugin-core@0.28.0

## 0.27.1

### Patch Changes

- @hot-updater/core@0.27.1
- @hot-updater/plugin-core@0.27.1

## 0.27.0

### Minor Changes

- 81f9437: feat(android): for safe reloading, Android reloads the process (#869)

### Patch Changes

- Updated dependencies [81f9437]
  - @hot-updater/core@0.27.0
  - @hot-updater/plugin-core@0.27.0

## 0.26.2

### Patch Changes

- @hot-updater/core@0.26.2
- @hot-updater/plugin-core@0.26.2

## 0.26.1

### Patch Changes

- @hot-updater/core@0.26.1
- @hot-updater/plugin-core@0.26.1

## 0.26.0

### Patch Changes

- @hot-updater/core@0.26.0
- @hot-updater/plugin-core@0.26.0

## 0.25.14

### Patch Changes

- @hot-updater/core@0.25.14
- @hot-updater/plugin-core@0.25.14

## 0.25.13

### Patch Changes

- @hot-updater/core@0.25.13
- @hot-updater/plugin-core@0.25.13

## 0.25.12

### Patch Changes

- @hot-updater/core@0.25.12
- @hot-updater/plugin-core@0.25.12

## 0.25.11

### Patch Changes

- @hot-updater/core@0.25.11
- @hot-updater/plugin-core@0.25.11

## 0.25.10

### Patch Changes

- 90f9610: Improve native build logging stream handling and make iOS child process
  termination on Ctrl+C more reliable.
- Updated dependencies [03c5adc]
  - @hot-updater/plugin-core@0.25.10
  - @hot-updater/core@0.25.10

## 0.25.9

### Patch Changes

- Updated dependencies [6b22072]
  - @hot-updater/plugin-core@0.25.9

## 0.25.8

### Patch Changes

- @hot-updater/plugin-core@0.25.8

## 0.25.7

### Patch Changes

- @hot-updater/plugin-core@0.25.7

## 0.25.6

### Patch Changes

- @hot-updater/plugin-core@0.25.6

## 0.25.5

### Patch Changes

- @hot-updater/plugin-core@0.25.5

## 0.25.4

### Patch Changes

- 8c83ff2: Add support for hot-updater.config.mjs
  - @hot-updater/plugin-core@0.25.4

## 0.25.3

### Patch Changes

- @hot-updater/plugin-core@0.25.3

## 0.25.2

### Patch Changes

- @hot-updater/plugin-core@0.25.2

## 0.25.1

### Patch Changes

- @hot-updater/plugin-core@0.25.1

## 0.25.0

### Patch Changes

- @hot-updater/plugin-core@0.25.0

## 0.24.7

### Patch Changes

- 294e324: fix: update babel plugin path in documentation and plugin files
- Updated dependencies [294e324]
  - @hot-updater/plugin-core@0.24.7

## 0.24.6

### Patch Changes

- 9d7b6af: feat(aws): sso template with fromSSO
  - @hot-updater/plugin-core@0.24.6

## 0.24.5

### Patch Changes

- @hot-updater/plugin-core@0.24.5

## 0.24.4

### Patch Changes

- Updated dependencies [7ed539f]
  - @hot-updater/plugin-core@0.24.4

## 0.24.3

### Patch Changes

- @hot-updater/plugin-core@0.24.3

## 0.24.2

### Patch Changes

- @hot-updater/plugin-core@0.24.2

## 0.24.1

### Patch Changes

- @hot-updater/plugin-core@0.24.1

## 0.24.0

### Patch Changes

- @hot-updater/plugin-core@0.24.0

## 0.23.1

### Patch Changes

- @hot-updater/plugin-core@0.23.1

## 0.23.0

### Patch Changes

- @hot-updater/plugin-core@0.23.0

## 0.22.2

### Patch Changes

- @hot-updater/plugin-core@0.22.2

## 0.22.1

### Patch Changes

- @hot-updater/plugin-core@0.22.1

## 0.22.0

### Patch Changes

- @hot-updater/plugin-core@0.22.0

## 0.21.15

### Patch Changes

- @hot-updater/plugin-core@0.21.15

## 0.21.14

### Patch Changes

- @hot-updater/plugin-core@0.21.14

## 0.21.13

### Patch Changes

- @hot-updater/plugin-core@0.21.13

## 0.21.12

### Patch Changes

- Updated dependencies [5c4b98e]
  - @hot-updater/plugin-core@0.21.12

## 0.21.11

### Patch Changes

- d6c3a65: chore(cli-tools): peerDeps
- e2b67d7: fix(cli-tools): esm only package bundle
- Updated dependencies [e2b67d7]
  - @hot-updater/plugin-core@0.21.11

## 0.21.10

### Patch Changes

- @hot-updater/plugin-core@0.21.10

## 0.21.9

### Patch Changes

- aa399a6: chore: deps picocolors
- Updated dependencies [aa399a6]
  - @hot-updater/plugin-core@0.21.9

## 0.21.8

### Patch Changes

- 3fe8c81: feat(plugin-core): reduced deps for edge-runtime
- Updated dependencies [3fe8c81]
  - @hot-updater/plugin-core@0.21.8
