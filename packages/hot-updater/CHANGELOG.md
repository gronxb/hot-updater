# hot-updater

## 1.2.0-rc.12

### Patch Changes

- 67a4892: Say what a missing secret means and how to store it, and count a missing upload keystore once.
  - A missing `secret()` that nothing reads yet, and one that an adapter reads on the next deploy, now print as `▲` warnings with a reason and a next step, as doctor's other warnings do. A build credential names the command that stores it, which imports a signing key and never issues a new one. An adapter credential names its `.env.hotupdater` variable and `npx hot-updater secrets import`, or, without a team store, the variable to set. The Secrets block itself is `◇`, and `--json` keeps the same codes and fields, with the new `message` and `resolution`.
  - A release's missing upload keystore is counted once, as the Secrets error. The Google Play row still marks the package `✗ upload keystore missing`, but is no longer a warning of its own when that is its only problem: `Doctor found 1 error.` rather than `1 error, 1 warning`.

- @hot-updater/android-helper@1.2.0-rc.12
  - @hot-updater/apple-helper@1.2.0-rc.12
  - @hot-updater/bsdiff@1.2.0-rc.12
  - @hot-updater/cli-tools@1.2.0-rc.12
  - @hot-updater/console@1.2.0-rc.12
  - @hot-updater/protocol@1.2.0-rc.12
  - @hot-updater/server@1.2.0-rc.12
  - @hot-updater/plugin-core@1.2.0-rc.12

## 1.2.0-rc.11

### Patch Changes

- 4c10736: Warn on a missing secret nothing reads, close every doctor run with its counts, and keep Infisical errors within 76 columns.
  - A `secret()` that is missing and that no build reads, such as a debug variant's keystore or a simulator scheme's App Store Connect API key, is now a warning: the Secrets block is marked `▲`, the run still passes with exit code 0, and `--json` lists it as a `SECRETS_MISSING_UNUSED` warning in `details.secrets.issues`. A missing name an adapter's `secret()` reads is a `DEPLOY_SECRETS_MISSING` warning in `details.deploySecrets.issues`.
  - Doctor's last line counts what it found. A run with warnings ends `All checks passed with 2 warnings.`, and a failing run, the `--scope` checks included, now ends `Doctor found 1 error, 2 warnings.` before it exits with code 1.
  - Messages the CLI breaks into lines, such as a secrets adapter's errors, now fit 76 display columns with clack's `│  ` in front, measured as a terminal shows them rather than by length. `infisical()` cuts Infisical's own message to fit, and names the project on one line and the environment and folder on the next. A URL that can't fit stays alone on its line.

- Updated dependencies [4c10736]
  - @hot-updater/cli-tools@1.2.0-rc.11
  - @hot-updater/android-helper@1.2.0-rc.11
  - @hot-updater/apple-helper@1.2.0-rc.11
  - @hot-updater/bsdiff@1.2.0-rc.11
  - @hot-updater/console@1.2.0-rc.11
  - @hot-updater/protocol@1.2.0-rc.11
  - @hot-updater/server@1.2.0-rc.11
  - @hot-updater/plugin-core@1.2.0-rc.11

## 1.2.0-rc.10

### Patch Changes

- fd2aa7e: Fail `hot-updater doctor` on a signing secret a build needs, and keep secrets errors within 76 columns.
  - A `secret()` that a build or a deploy reads and that resolves nowhere now fails doctor: an error under the Secrets block with the command that imports the existing key, no "All checks passed", and exit code 1, for `--json` too. "Needed" is what the build resolves: an iOS device scheme's `signing.ascApiKey`, a release variant's `signing.keystore`, and `signing` while bundle signing is on. A simulator scheme, a debug variant, or `enabled: false` reads nothing, so its missing secret stays a `missing, unused` row. An adapter doctor can't read stays a warning. `--json` gives each reference `required`, and a `message` when a required one is missing.
  - The Google Play row marks a package ✗, `upload keystore missing`, when the keystore its release signs with is missing, and `--json` adds `missingKeystore` to that package.
  - Deploy prints a missing signing key's next step on a line of its own, as the error lays it out, instead of folding it into the sentence before it. Text the CLI prints that is already laid out in lines keeps them.
  - `keys export-public` prints `Public key not exported.` with its cause on the lines after it, doctor and `init` put a secrets adapter's error under `Couldn't read the <adapter> secrets adapter.`, and `infisical()`, `localSecrets()`, and `secret()` break a line that a long name, folder, path, or URL would widen past 76 columns. A URL longer than a line gets a line of its own.

- Updated dependencies [41444fa]
- Updated dependencies [fd2aa7e]
  - @hot-updater/apple-helper@1.2.0-rc.10
  - @hot-updater/cli-tools@1.2.0-rc.10
  - @hot-updater/android-helper@1.2.0-rc.10
  - @hot-updater/bsdiff@1.2.0-rc.10
  - @hot-updater/console@1.2.0-rc.10
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

- Updated dependencies [12ff126]
  - @hot-updater/cli-tools@1.2.0-rc.9
  - @hot-updater/android-helper@1.2.0-rc.9
  - @hot-updater/apple-helper@1.2.0-rc.9
  - @hot-updater/bsdiff@1.2.0-rc.9
  - @hot-updater/console@1.2.0-rc.9
  - @hot-updater/protocol@1.2.0-rc.9
  - @hot-updater/server@1.2.0-rc.9
  - @hot-updater/plugin-core@1.2.0-rc.9

## 1.2.0-rc.8

### Minor Changes

- 297f916: `infisical()` needs only `projectId`: `secrets: infisical({ projectId: "…" })`. `environment` defaults to `"prod"` and `path` to `"/"`. Without `siteUrl`, it reads the instance from `INFISICAL_DOMAIN`, then `INFISICAL_API_URL`, as the Infisical CLI does, before Infisical Cloud's US region. The `auth` option is removed: it signs in only from the environment or `.env.hotupdater`, with `INFISICAL_TOKEN`, Universal Auth, or GitHub Actions OIDC with `INFISICAL_MACHINE_IDENTITY_ID`, requesting the ID token with GitHub's default audience. Without any of them, it says in two lines which variables to set and links the guide.
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
- Updated dependencies [8a440e3]
- Updated dependencies [2e3f250]
- Updated dependencies [21cfeec]
- Updated dependencies [c463534]
- Updated dependencies [5358377]
  - @hot-updater/android-helper@1.2.0-rc.8
  - @hot-updater/cli-tools@1.2.0-rc.8
  - @hot-updater/apple-helper@1.2.0-rc.8
  - @hot-updater/plugin-core@1.2.0-rc.8
  - @hot-updater/console@1.2.0-rc.8
  - @hot-updater/server@1.2.0-rc.8
  - @hot-updater/bsdiff@1.2.0-rc.8
  - @hot-updater/protocol@1.2.0-rc.8

## 1.2.0-rc.7

### Patch Changes

- 5b13b16: `google-play login` asks which Google Account to use when gcloud already holds one: the accounts gcloud holds, the active one first, or "Sign in with another Google Account", which runs `gcloud auth login` and uses the account it adds. It reads the access token of the chosen account and leaves gcloud's active account as it was. The Play Console invite, and the refusal when the key never reaches the app, name the exact permission to grant: the app permission "Release apps to testing tracks", under App permissions rather than account-wide.
- f3989de: rc.6 QA fixes. A CI iOS build revokes only the signing certificates Xcode created in its keychain, never the Apple CA intermediates imported beside them, and a certificate it can't revoke is named on one line with its serial on the next, then the page to revoke it. When Apple's Program License Agreement isn't accepted, the build failure, TestFlight uploads, the certificate revocation, and key issuing say the Account Holder must accept it at developer.apple.com/account. `secrets import` takes the env file to read, `.env.hotupdater` by default, reads only that file, and lists the names it stored one per line. A secrets adapter that can't be read names the secret and the adapter above its own error. `secrets issue asc-api-key` and `apple login` name the team the key was issued in.
- Updated dependencies [5b13b16]
- Updated dependencies [f3989de]
  - @hot-updater/android-helper@1.2.0-rc.7
  - @hot-updater/apple-helper@1.2.0-rc.7
  - @hot-updater/cli-tools@1.2.0-rc.7
  - @hot-updater/bsdiff@1.2.0-rc.7
  - @hot-updater/console@1.2.0-rc.7
  - @hot-updater/protocol@1.2.0-rc.7
  - @hot-updater/server@1.2.0-rc.7
  - @hot-updater/plugin-core@1.2.0-rc.7

## 1.2.0-rc.6

### Patch Changes

- 755bde5: rc.5 QA fixes. Doctor's advice for managed credentials the config reads with `process.env` names init's command only for a deployment init manages; for one an agent infrastructure scaffold keeps, or a config of your own, it is one line and the `secretEnv` docs link. `google-play login` checks for gcloud before any question, uses the account's only Google Cloud project with the Google Play Android Developer API, and otherwise asks which project to use or whether to create one, instead of creating a new project. `apple login` and `secrets issue` help no longer name asc, and a shortcut's refusal of an option is two short lines with the full command.
- Updated dependencies [755bde5]
  - @hot-updater/android-helper@1.2.0-rc.6
  - @hot-updater/apple-helper@1.2.0-rc.6
  - @hot-updater/bsdiff@1.2.0-rc.6
  - @hot-updater/cli-tools@1.2.0-rc.6
  - @hot-updater/console@1.2.0-rc.6
  - @hot-updater/protocol@1.2.0-rc.6
  - @hot-updater/server@1.2.0-rc.6
  - @hot-updater/plugin-core@1.2.0-rc.6

## 1.2.0-rc.5

### Patch Changes

- dd7db4b: `secrets issue android-keystore` creates the Android upload key with the JDK's keytool and stores it through the secrets adapter, and `google-play login` sets it up after the Play service account: a new key, or the keystore you have.
- 1489a30: Doctor's outdated-server advice for a deployment an agent infrastructure scaffold keeps is one line and the `agent infra upgrade` command, named once, as for a deployment init manages. The preview, migration and deploy order stay in the scaffold's `upgrades/README.md`. `--json` keeps its fields.
- 709997a: `google-play login` signs in to Google with the gcloud CLI, running `gcloud auth login` when no account is active, and needs no Google OAuth client of your own (`HOT_UPDATER_GOOGLE_OAUTH_CLIENT_ID`/`_SECRET` are gone) and no Play Console developer account ID. The package name is filled in from the config's `nativeBuild.android` schemes (a choice when they declare several), as `native-build android --submit play-internal` does. The service account goes in the Google Cloud project "Hot Updater Play" an earlier run created, or a new one, without asking; only when Google refuses to create a project does it ask for one of the account's projects. After creating the key, it opens Play Console's invite page for the service account and waits, up to 10 minutes, until the key can reach the app; when it never does, it deletes the key and says to invite the service account and run `npx hot-updater google-play login` again.
- 5d4d977: The config managed `init` writes names the provider's resources and reads its credentials with `secretEnv`, so a team store in `secrets` shares them: `init` stores them there with `HOT_UPDATER_API_KEY` and reads a missing one back, and `secrets import` moves an existing project's from `.env.hotupdater`. Doctor lists where each `secretEnv` name comes from. The storage and database adapters take a credential as a string or a function.
- 2fd1c83: A configured `secrets` adapter is the only store: the CLI no longer reads `~/.hot-updater/secrets/` under it or writes there for it, so a teammate with the config and store access sees what you see. An issued key must read back exactly through the adapter, or it is revoked; the run uses it from memory. When the environment overrides a key the adapter lacks, `apple login` and `google-play login` add an `Adapter` row. `hot-updater doctor` lists each `secret:` reference and whether the adapter, the environment, or nothing holds it, with matching `--json` fields.
- Updated dependencies [dd7db4b]
- Updated dependencies [709997a]
- Updated dependencies [5d4d977]
- Updated dependencies [2fd1c83]
  - @hot-updater/android-helper@1.2.0-rc.5
  - @hot-updater/cli-tools@1.2.0-rc.5
  - @hot-updater/plugin-core@1.2.0-rc.5
  - @hot-updater/apple-helper@1.2.0-rc.5
  - @hot-updater/console@1.2.0-rc.5
  - @hot-updater/server@1.2.0-rc.5
  - @hot-updater/bsdiff@1.2.0-rc.5
  - @hot-updater/protocol@1.2.0-rc.5

## 1.2.0-rc.4

### Patch Changes

- ebb223a: `apple login` and `google-play login` report a key already stored, or set by the environment, and exit 0 without a terminal too, as in CI; only a sign-in needs one. Doctor's outdated-server advice is one line and init's command, named once: when the database also has migrations to run, the schema check names it instead. `agent infra upgrade` names `upgrades/README.md` once, and each file relative to the templates' directory. `native-build --dry-run` ends with one line, such as `Dry run: not recorded or submitted to TestFlight`, after the build's block, without repeating its rows; the app version and fingerprint steps read `iOS app version 1.7.0`, and the `.app file created` line is gone. `keys generate` prints its keys under a `Keys generated` heading. `--json` output is unchanged.
- Updated dependencies [ebb223a]
  - @hot-updater/apple-helper@1.2.0-rc.4
  - @hot-updater/android-helper@1.2.0-rc.4
  - @hot-updater/bsdiff@1.2.0-rc.4
  - @hot-updater/cli-tools@1.2.0-rc.4
  - @hot-updater/console@1.2.0-rc.4
  - @hot-updater/protocol@1.2.0-rc.4
  - @hot-updater/server@1.2.0-rc.4
  - @hot-updater/plugin-core@1.2.0-rc.4

## 1.2.0-rc.3

### Patch Changes

- 3c00e7a: The commands new in 1.2 print short output that fits an 80-column terminal: one idea per line, `Label  value` rows padded to a common width, paths with `~` or relative to the project and shortened in the middle, and bare highlighted commands without backticks. A result with nothing to do, such as `apple login` with a key already stored, states the result and stops; a next step is printed only when you have to act. `apple login` and `google-play login` name the one place they found the key. Doctor prints each issue and its resolution as one entry, a sentence per line. `--json` output is unchanged.
- Updated dependencies [3c00e7a]
  - @hot-updater/cli-tools@1.2.0-rc.3
  - @hot-updater/apple-helper@1.2.0-rc.3
  - @hot-updater/android-helper@1.2.0-rc.3
  - @hot-updater/bsdiff@1.2.0-rc.3
  - @hot-updater/console@1.2.0-rc.3
  - @hot-updater/protocol@1.2.0-rc.3
  - @hot-updater/server@1.2.0-rc.3
  - @hot-updater/plugin-core@1.2.0-rc.3

## 1.2.0-rc.2

### Patch Changes

- 76090c3: `hot-updater channel set <channel>` in an Expo CNG project points at the `@hot-updater/expo` plugin's `channel` option as where the build takes its channel from. For a dynamic `app.config.*` it shows that option read from an environment variable, as the pull request preview guide does (`channel: process.env.PREVIEW_CHANNEL ?? "production"`), and the variable to build with (`PREVIEW_CHANNEL=<channel>`), instead of a channel to hardcode. For a static `app.json` it shows the option set to the channel, as JSON.
- Updated dependencies [76090c3]
  - @hot-updater/console@1.2.0-rc.2
  - @hot-updater/android-helper@1.2.0-rc.2
  - @hot-updater/apple-helper@1.2.0-rc.2
  - @hot-updater/bsdiff@1.2.0-rc.2
  - @hot-updater/cli-tools@1.2.0-rc.2
  - @hot-updater/protocol@1.2.0-rc.2
  - @hot-updater/server@1.2.0-rc.2
  - @hot-updater/plugin-core@1.2.0-rc.2

## 1.2.0-rc.1

### Patch Changes

- 939651e: Fixes from the 1.2.0-rc.0 QA of `hot-updater doctor` and the CLI.
  - Without `--server-base-url`, doctor checks the server an agent infrastructure scaffold records in `hot-updater-infra/<provider>/*/deployment.json`, naming the file in `details.infrastructure.recordedIn`. When none records one, or several record different servers, it reports `details.infrastructureUnchecked`: the server's version was not checked, and `npx hot-updater doctor --server-base-url <url>` checks it. It no longer reports success with nothing about the skip.
  - Init's command names `--from-env-file .env.hotupdater` only when that file holds the init record and every input doctor compared, as doctor read them. When they came from the environment, such as CI's variables or a file the config loads, the command names `--build` and `--from-env-file <env file>` and says that init needs them too.
  - For a deployment an agent infrastructure scaffold in `hot-updater-infra/<provider>/` keeps (its `deployment.json` records a deployed server on the configured database, and the config lists only the official plugins), doctor names `npx hot-updater agent infra upgrade --provider <provider> --build <build>` and its upload, preview, migrate and deploy order instead of init, which would deploy without a preview and leave the scaffold behind.
  - When the console's port is taken, `hot-updater console` says that `console.port` in hot-updater.config.ts changes it.
  - The upgrade files the agent infrastructure scaffold copies, such as `upgrades/1.2.0.md`, are oxfmt-formatted as shipped, so a project's formatter keeps them as generated and their manifest hashes hold.

- cd5fa07: `hot-updater native-build ios` removes the temporary directories it builds in, which it used to leave in the system's temporary directory, 10 GB or more each.
  - The Xcode DerivedData of a simulator build, which can take 10 GB or more, is removed once the `.app` is copied out of it, whether the build succeeds or fails.
  - The `.xcarchive` and the export are written straight to the build directory, instead of temporary directories copied into it.
  - The build directory is removed once its artifact is copied to the output path, and a failed build removes it, and every other directory it used, right away.
  - A build interrupted with Ctrl+C, or ended by a signal, removes them too.
  - The build log in `.hot-updater/log` stays where it is, after a failed build too.

- bcc239a: The Console's Install card says each thing about installing a native build once: the QR code's caption says what scanning gets, and the steps beside it add only another way, such as `adb`, `xcrun simctl`, Xcode or Apple Configurator, or the `testflight` and `google-play upload` commands. An AAB's card no longer says twice that it installs through Google Play or bundletool.

  A native build's Console download link, as a pull request preview's comment shows it, opened in a browser without a Console session, goes to the build's page to sign in, and sign-in returns to the download. The build's page names the download in `returnTo`, relative to the page, and sign-in takes it only on the Console's own origin; anything else returns to the page. A request that isn't a browser navigation still gets the 401.

  `hot-updater channel set <channel>` says per platform when it found no `AndroidManifest.xml` or `Info.plist` and wrote nothing, instead of a success line, and asks for a rebuild only when it wrote a file. In an Expo CNG project it says that builds take the channel from the `@hot-updater/expo` plugin's `channel` option in the project's `app.json` or `app.config.*`, which `expo prebuild` writes into the native files, and shows that option set to the channel given, not `production`.

- Updated dependencies [cd5fa07]
- Updated dependencies [bcc239a]
  - @hot-updater/apple-helper@1.2.0-rc.1
  - @hot-updater/console@1.2.0-rc.1
  - @hot-updater/android-helper@1.2.0-rc.1
  - @hot-updater/bsdiff@1.2.0-rc.1
  - @hot-updater/cli-tools@1.2.0-rc.1
  - @hot-updater/protocol@1.2.0-rc.1
  - @hot-updater/server@1.2.0-rc.1
  - @hot-updater/plugin-core@1.2.0-rc.1

## 1.2.0-rc.0

### Minor Changes

- 6276804: Sign in with your Apple Account to issue the App Store Connect API key. An iOS build that needs a key for `signing.ascApiKey` or `--submit testflight` and finds none asks for the Apple Account, its password (masked), and the two-factor code in Hot Updater's own prompts in a terminal, issues a team key named `hot-updater <date>` with the Admin role through asc, the open-source App Store Connect CLI, stores it through the config's `secrets` adapter, `localSecrets()` by default, which keeps it in `~/.hot-updater/secrets/<project-key>/` on this machine, and continues; `hot-updater secrets issue asc-api-key [name]`, or its shortcut `hot-updater apple login`, which takes no options or arguments, does the same ahead of time, the only command that signs in before a build. It keeps a key the adapter or the environment already provides, printing where it is and its key ID. Keys are per machine: on one without a key, it says before signing in that it will issue a new key, and how to share one key across machines instead; after issuing, it names the App Store Connect page where you revoke the keys no machine uses anymore. `--replace` issues a new key, stores it, and names the old key ID with where to revoke it in App Store Connect, never revoking it itself, since CI may still use it. `hot-updater secrets put` only imports a key you have (`--p8`, `--key-id`, `--issuer-id`) and points to `apple login` without them. Builds and `apple login` without a terminal or in CI never sign in: builds use the stored key and refuse with `npx hot-updater apple login` when there is none, or `npx hot-updater secrets issue asc-api-key <name>` for a key named otherwise. Hot Updater keeps no Apple session, so there is no logout: each sign-in ends naming the key it stored and where. Only the issued key is kept: asc's session, config, and the `.p8` live in a temporary directory that is deleted, and a key that surely was not stored is revoked again.
- 3462a9a: A store install's first OTA downloads a Hermes patch from the built-in bundle of its registered native build.
  - `hot-updater deploy` adds the built-in bundle of the newest native build `native-build ios|android` tracked for the deploy's channel, platform, and fingerprint or exact app version to its patch bases, beside the `patch.maxBaseBundles` released ones, in one indexed read. A built-in bundle newer than the deployed bundle, or a self-hosted server without the native build routes, adds none.
  - With no OTA installed, the iOS and Android runtimes apply a patch whose base is the app's MIN_BUNDLE_ID to a copy of the packaged Hermes file, after checking it against the patch's base file hash. When store processing changed the file, they download the complete file instead, and report `patchFallback`.
  - The runtimes choose between per-file downloads and `bundle.tar.br` counting only the patches they can apply: a built-in patch counts once the packaged file has been checked against its base.

- d7f02a6: Native builds run in CI without signing in. The CLI treats a run as CI when `CI` is set or it has no terminal: it asks nothing there, even on a terminal a runner allocates, and never starts an Apple or Google sign-in. `native-build ios` and `native-build android` resolve every credential they sign and upload with before the build adapter's prebuild, so a missing one fails in seconds; the error names the `secrets` adapter and where it keeps the credential, the command that stores it once (`apple login` or `google-play login` for a key Hot Updater issues, `secrets put` for a keystore), and the environment variables that provide it instead. In CI, an iOS build that signs with an App Store Connect API key archives and exports in a keychain of its own, restores the runner's keychains afterwards, and revokes the development certificates Xcode created in it, so runners that start empty don't pile up certificates. The new `actions/native-build` GitHub Action runs `native-build <platform> --submit` with the job's environment, its `submit` input naming the store, and the "Build and upload from CI" guide has a complete workflow that maps GitHub Actions secrets to the job's environment. When the build fails, the action uploads the CLI's build log as the `hot-updater-build-log-<platform>-<scheme>` artifact and sets it as the `build-log` output.
- 28dfe97: The Console's **Native builds** tab lists the native builds Hot Updater tracks, installs them, and shows each one's built-in bundle, the diff baseline its OTAs patch from.
  - **Native builds** (`/native-builds`) lists the tracked builds, newest first, one read per page, with each build's channel, fingerprint or app version, built-in bundle, and commit. `?channel=<name>` lists only the builds that embed a channel, also one read per page. A row opens the build's page.
  - A build's page, `/native-builds/<id>`, reads five times whatever the build. **Install** shows an APK's QR code and `adb install` command, a simulator app's `xcrun simctl install` command, TestFlight for an IPA's testers, and a download for every build. **Built-in bundle** shows the min bundle ID its OTAs patch from, how many bundles patch from it, and whether it is its scope's newest build, which new deploys patch from, or the build that superseded it. **Served now** lists what the update check offers an install of the build, newer than its built-in bundle, and whether each first OTA downloads as a patch or as the full bundle. **Patches from this build** pages the patches from its built-in bundle.
  - `/api/native-builds/<id>/download` redirects to the storage's download URL on each request, so the link never expires; a browser without a Console session goes to the build's page, which signs it in and returns to the build. The APK QR code holds the storage URL itself, read again every 30 seconds while it shows, so a phone needs no Console sign-in. `/_hot-updater/native-builds/qr?build=<id>` serves the QR code of a build's download link without a session and without a read.
  - **Import a build**, beside the refresh button and in an empty list's next steps, shows the `npx hot-updater native-build import <path-to-.ipa|.aab|.apk|.app|.app.zip>` command that tracks a build made elsewhere, with its `-c/--channel` option and a link to the import guide; the Console uploads nothing.
  - Sign-in returns to the Console page that asked for it.
  - A bundle's detail sheet links to the newest native build of its release's scope, and says whether the bundle has a patch from it.
  - `hot-updater channel delete <channel>` disables and deletes a channel's bundles, then the channel, as when a pull request closes. A missing channel succeeds without a change; a channel a native build embeds is kept, and the command exits with status 1.
  - Core's API adds `getNativeBuild(id)`, one read by key, served at `GET /native-builds/:id`, and `listNativeBuilds({ channelId })`, one read of the channel's builds, served at `GET /native-builds?channelId=`; `standaloneRepository` maps both.

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

- 43b0a61: Sign in with Google to issue the Play service account key. `native-build android --submit play-internal` that finds no `play-service-account` in the config's `secrets` adapter opens Google's sign-in page in a terminal, checks that the account administers the Play Console developer account and that Google Play has the app, then creates the service account `hot-updater-play` in a Google Cloud project you pick or a new one, gives it release access to the app in Play Console, creates its JSON key, stores it through the adapter, `localSecrets()` by default, which keeps it in `~/.hot-updater/secrets/<project-key>/` on this machine, and continues; `hot-updater secrets issue play-service-account [name]`, or its shortcut `hot-updater google-play login`, which takes no options or arguments, does the same ahead of time, and ends naming the service account whose key it stored and where: Hot Updater keeps no Google session. It keeps a service account the adapter or the environment already provides, printing where it is and its email. Keys are per machine: on one without a key, it says before signing in that it will create a new key, and how to share one key across machines instead; after creating it, it names the service account's keys page in Google Cloud, where you delete the keys no machine uses anymore. `--replace` issues a new key, stores it, and names the old key with where to delete it under the service account's keys in Google Cloud, never deleting it itself. `hot-updater secrets put` only imports a key file you have (`--service-account`). Builds without a terminal use the stored key, and refuse with `npx hot-updater google-play login` when there is none. Only the key is kept: the sign-in's access token is revoked, and a key that surely was not stored is deleted again. Until Hot Updater ships its own OAuth client, the sign-in needs a "Desktop app" OAuth client of yours in `HOT_UPDATER_GOOGLE_OAUTH_CLIENT_ID` and `HOT_UPDATER_GOOGLE_OAUTH_CLIENT_SECRET`, and stops before opening the browser without one.
- 1ad0ebe: Local PEM signing reads its private key from the config's `secrets` adapter with `signing: { enabled: true, privateKey: "secret:<name>" }`, beside `privateKeyPath`. The CLI reads the secret once per run, when it first derives the public key or signs, masks it in its output, and keeps it in memory only; a missing secret fails the deploy with where it was looked for. Without an adapter, `secret:bundle-signing-key` is `HOT_UPDATER_BUNDLE_SIGNING_KEY` in the environment, where a one-line PEM with `\n` for its line breaks reads as the PEM, and otherwise `localSecrets()`'s directory on this machine.

  `hot-updater keys generate --secret [name]` stores the private key as that secret, `bundle-signing-key` by default, through the config's adapter, or in `localSecrets()`'s directory on this machine (`~/.hot-updater/secrets/<project-key>/<name>.json`, readable by you alone) without one, and writes only `public-key.pem`. It never replaces a secret it reads a value from.

- 89cd5ce: `hot-updater doctor` reports a database whose schema is behind, and names the command that migrates it.
  - `hot-updater doctor` reads the database `hot-updater.config.ts` names through the schema fence, as the server does, and reports `SCHEMA_MIGRATION_PENDING` with each settings row a migration writes: after upgrading to a release whose schema changed, or after adding a plugin to `plugins`. It checks the release catalogs once the schema passes. A row newer than the CLI expects is `SCHEMA_NEWER_THAN_CLI`; a v0 database is `SCHEMA_NOT_MIGRATABLE`; and a plugin of your own whose stored version differs is `PLUGIN_SCHEMA_CHANGED`, left to its own migration. Doctor names no migration while any of these stands.
  - The managed D1 and Supabase schemas ship as one migration per release that changes them, starting with `0002_hot-updater_1.2.0.sql`, after the unchanged `0001_hot-updater_1.0.0.sql`. Each holds what the earlier ones do not create, with Supabase's apply RPC, its grants, and row-level security for new tables, then every settings row. `hot-updater init`, run again with its saved inputs, applies them.
  - The schema fence's errors send you to `npx hot-updater doctor`, which names the command for the database.
  - The Console shows a migration notice, with the settings and the command, instead of failing on every page while its database needs a migration.

- 79c81f6: `hot-updater native-build ios` and `native-build android` reuse a build instead of building again when nothing that can change the artifact changed. After the build adapter's prebuild, each build computes a native build key (`nbk1:` and a SHA-256) of every file of the git repository, the ignored native project files, `.env*` files, the install state and installed native packages it reads, what Expo and React Native CLI autolinking link (the config it prints, without this machine's directories, and each linked package file by file, wherever it is, with the ignored files of the repository's packages), the scheme's settings and files, the channel and fingerprint or app version, the signing identity (never a password or key), the toolchain, and the environment variables the build reads. A build the registry tracks with that key, whose artifact storage holds, is copied or downloaded to the output path, and nothing is built, tracked, or uploaded; else this machine's cached build with the key, such as a `--dry-run`'s, is tracked with its own min bundle ID; else the CLI builds and says what changed since the cached build. The CLI keeps one build per platform and scheme under `cacheDir`. A build no key can cover (Debug, outside git, autolinking that can't run, no `Podfile.lock` or `Package.resolved`, a dynamic Gradle version without a lockfile, environment reads by a computed name, device-list export methods, uninstalled provisioning profiles) always builds, and says why. `--no-cache` builds anyway and still records the key; `--submit` skips a reused build the store already has (`findTestFlightBuild` in `@hot-updater/apple-helper`, `findPlayInternalRelease` and `readBuiltVersionCode` in `@hot-updater/android-helper`); `--json` adds `cache: { hit, key, uncacheable, changed }`. The key is separate from the fingerprint, which keeps deciding which OTA updates a build takes, and `native-build find` keeps finding builds by scope.

  Core's `native_builds` table has the nullable `build_key` column and the `byBuildKey` index, in the managed `0002_hot-updater_1.2.0.sql` migrations and the PostgreSQL schema. `NativeBuildRegistration` takes `buildKey`, `NativeBuildRow` has `build_key`, and `findNativeBuild(scope, { buildKey })` finds the newest build of a scope with a key in one read, also through `GET /native-builds/latest?buildKey=` and `standaloneRepository`, which reads a server's answer without the key as no build.

- 4d8e0d2: Every native build `hot-updater native-build ios|android` makes is tracked in Hot Updater's native build registry, with no flag to opt out.
  - Core's schema moves to 1.2.0 with the `native_builds` table, in the managed D1 and Supabase `0002_hot-updater_1.2.0.sql` migrations; `hot-updater init`, run again with its saved inputs, applies it. The table changes no existing one: its references to `channels` and `bundles` keep no counters.
  - Before it builds, and before any Apple or Google sign-in, the CLI checks read-only that it can track the build: it asks the registry for the build's scope (for its newest build when the build adapter's prebuild has yet to generate the native project), and reads back (`exists`) the artifact of a build the registry already tracks there; when the database or the storage can't be reached, it stops in seconds naming which, and builds nothing. A Debug build, which loads its JavaScript from Metro and has no built-in bundle, is not tracked: the CLI says so before it builds, and `--json` reports `registration: { skipped: "debug" }`. When tracking fails after the build, the CLI exits with the artifact's path and submits it to no store.
  - `--dry-run` builds but records and submits nothing, as `npm publish --dry-run` does: it runs the checks read-only, reads the store key `--submit` would use without signing in or issuing one, keeps the artifact on this machine, and prints what it would have recorded and where it would have submitted. A missing store key is reported, the build still runs, and the command exits 1 at the end. With `--json`, the last line has `dryRun: true`, `registration: { skipped: "dry-run" }`, and `submission: { skipped: "dry-run", destination }`.
  - Tracking takes the JavaScript bundle a release build compiled in out of the artifact (`assets/index.android.bundle` in an `.apk`, `base/assets/index.android.bundle` in an `.aab`, `main.jsbundle` in an `.ipa` or `.app`), uploads the artifact to `native-builds/<platform>/<id>/` in the config's storage (a simulator `.app` as one `.app.zip`), uploads that bundle as the build's built-in bundle, a bundle whose ID is the MIN_BUNDLE_ID and whose manifest lists only that file at an OTA bundle's asset path, then registers both. It uses the config's `database` and `storage`, as deploy does.
  - A tracked build records the build number its artifact reports, `build_number` (`CFBundleVersion` from the app's Info.plist, `versionCode` read with `aapt2`), which the Console shows; registrations without it, as from an earlier CLI, store null.
  - A tracked build records the store track it was submitted to: `native_builds` has nullable `submitted_to` (`testflight` or `play-internal`), `submitted_at_ms`, and `submitted_version`, the store's version and build number. Core's `recordNativeBuildSubmission(id, { destination, version })` writes them in one read and one write, refusing another platform's store, and answers null for an unknown build; the admin API serves it at `POST /native-builds/:id/submission`, and `standaloneRepository` maps it.
  - Core's API adds `registerNativeBuild`, which writes the build and its built-in bundle's row in one transaction, `findNativeBuild`, the newest build of a platform, channel, and fingerprint or exact app version in one indexed read, and `listNativeBuilds`. The admin API serves them at `POST /native-builds`, `GET /native-builds/latest`, and `GET /native-builds`, and `standaloneRepository` maps them; a server without these routes answers 404, which the CLI reports as a server to upgrade.
  - A built-in bundle is no OTA bundle: no release publishes it, the bundle totals leave it out, core refuses to delete it or to release it, and `storage prune` keeps its files and the artifact. Update checks and artifact responses do not change.
  - `azureBlobStorage` and `firebaseStorage` stream uploads instead of reading them into memory.
  - `@hot-updater/android-helper` and `@hot-updater/apple-helper` export `extractBuiltInBundle`, and `@hot-updater/apple-helper` exports `archiveAppBundle`.

- ed37acf: `hot-updater native-build ios` and `hot-updater native-build android` build native apps, without `EXPERIMENTAL`: `native-build <platform> [-s <scheme>] [-o <path>] [--submit testflight|play-internal] [--dry-run] [--json]`, beside `native-build find`, `native-build delete`, and `native-build import`. They replace the experimental `build:ios` and `build:android`; `run:ios` and `run:android` are removed, with no alias: install the artifact (`xcrun simctl install`, `adb install`) or use your framework's run command. Without `--scheme`, the build asks for the scheme at a terminal, and in CI or without a terminal stops with the schemes to pass. A build returns and prints the artifact (`.apk`, `.aab`, `.ipa`, or simulator `.app`) with the values compiled into it: the MIN_BUNDLE_ID, the fingerprint hash or app version, and the default channel (the app version and channel are read from the built artifact: the app's Info.plist on iOS, and with the SDK's `aapt2` the merged manifest of the `.apk` or `.aab` on Android). The build adapter's `prebuild`, such as `expo prebuild`, now runs before the commands read the native projects. The CLI issues each MIN_BUNDLE_ID as the SDK's podspec script phase and Gradle task do, the UUIDv7 of the build's millisecond with zero random bits, stepped 1 ms forward past a bundle the registry already holds at it; a build whose MIN_BUNDLE_ID another build registered first, as one started in the same millisecond can, is refused when it is tracked, with an error that says so.

  `hot-updater native-build import <file> [-c <channel>] [--dry-run] [--json]` tracks an `.ipa`, `.aab`, `.apk`, or simulator `.app` (the directory or its `.app.zip`) built elsewhere, such as by another build service or an earlier release, as `native-build ios|android` tracks its own builds, with the build number it reports as the row's `build_number`, so OTAs deployed after it patch from its built-in bundle. It reads everything from the artifact: the platform, app version, build number, and app ID from the manifest or Info.plist, the channel the app reports (`production` without one), the MIN_BUNDLE_ID and the fingerprint from the string literals of the app's code (the dex files' string pool, or the Mach-O `__cstring` section of the executable or of HotUpdater's dynamic framework), and the built-in bundle. It prints what it read, then refuses an artifact without a built-in bundle (a Debug build), one built without `@hot-updater/react-native`'s build step (no MIN_BUNDLE_ID) or with several candidates, one without a fingerprint under the fingerprint strategy or without a comparable app version under the appVersion strategy, a channel given as a resource reference (unless `--channel` names the channel the app reports, as when its code sets one or it switches at runtime), and an artifact whose MIN_BUNDLE_ID is registered with another built-in bundle or scope, naming that native build. Importing the same build again succeeds and changes nothing, reporting `alreadyImported: true` under `--json`, so CI jobs can rerun. An app ID no `nativeBuild` scheme's `bundleIdentifier` or `applicationId` (by default its `packageName`) names is a warning. It then uploads the artifact and the built-in bundle and registers them with no build key and no commit; `--dry-run` reads and checks, and records nothing. The reader treats every artifact as untrusted input: it reads only the entries it needs through the zip's central directory, caps the directory, each entry it reads, and all it inflates, stops an entry that inflates past its declared size (a zip bomb), matches no absolute or `..` entry name and refuses a symbolic link or a doubled name among those it reads, writes nothing to disk by entry name, gives up after two minutes, and refuses a truncated or malformed archive, plist, or manifest as unreadable instead of crashing. `@hot-updater/protocol/native-artifact`, a subpath no app imports, exports the reader (`readNativeArtifact` over a `blobSource`, with no dependencies) and `checkNativeArtifact`.

  A `nativeBuild` scheme signs with a credential the CLI resolves while it builds: `signing: { keystore }` on Android passes an `android-keystore` to Gradle as the injected signing properties of release variants, and `signing: { ascApiKey }` on iOS signs device builds with automatic signing through an `asc-api-key`. Debug variants and simulator builds resolve nothing. With `signing.ascApiKey` and no `exportOptionsPlist`, an iOS device build exports for App Store Connect, and `native-build ios` refuses a device scheme with neither before it builds. The helpers' `minBundleId` and `credentials` are optional: without them, `buildAndroid` and `buildIos` issue a MIN_BUNDLE_ID of the build's millisecond (`createMinBundleId` from `@hot-updater/cli-tools`) and resolve signing credentials from the environment. `@hot-updater/android-helper` and `@hot-updater/apple-helper` no longer export `runAndroid`, `runIos`, or their device types. The build log in `.hot-updater/log` keeps the whole output of `xcodebuild` (also with `xcbeautify` installed, which now only formats the progress) or Gradle, through its last line. A failed build prints why on stderr, in `--json` mode too: `xcodebuild`'s `error:` lines and failed commands, or Gradle's `What went wrong` block, else the output's last 40 lines, then `Build log: <path>`, instead of the raw start of the tool's output; the helpers throw a `BuildFailedError` (`@hot-updater/cli-tools`) with the log's path and those lines.

- 6f9313b: Upload an Android build to Google Play's internal testing track with `hot-updater native-build android --submit play-internal`, or its shortcut `hot-updater google-play upload`.
  - `google-play upload` runs `native-build android`'s build, which tracks it, and takes only `--scheme`: any other option or argument exits 1 naming the full command. Without `--scheme`, it builds the one `nativeBuild.android` scheme Google Play takes (an `.aab`, not a `Debug` variant) and says which; with several, it asks at a terminal, and in CI or without a terminal it exits listing them with the full command. With none, it says why each scheme is refused and how to add one.
  - The upload authenticates with the `secrets` adapter's `play-service-account`, which `HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH` or `HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON` overrides. It is resolved before the build adapter's prebuild and the build, and stays in memory: the CLI writes the service account to no file, signs its token assertion in memory, and masks the private key and access token in its output.
  - It uses the Google Play Developer API: it opens an edit, uploads the `.aab` in a resumable upload one chunk at a time, releases its version code to the `internal` track, and commits the edit, deleting it when any step fails. The package name is the `.aab`'s, read with `aapt2`, or else the scheme's `applicationId`.
  - On an app Play Console has not published, the release is a draft; when the app's state requires it, the edit is committed without sending the changes for review. A taken version code, a missing app, and a service account without access are reported with what to change.
  - Before the prebuild, the CLI refuses a scheme Google Play would not take as a release: an `.apk` or a debug variant. Before it uploads, it refuses an `.aab` signed with the Android debug keystore, which Google Play refuses, read with the JDK's `keytool`.
  - Once Google Play takes the bundle, as a completed or draft internal release, the CLI records the submission on the tracked build, `submitted_to: "play-internal"` with the version name and code as `submitted_version` (`1.7.0 (66)`, or the code alone when `aapt2` can't read the name), and the Console's Native builds tab shows it. Only an upload the run made is recorded; a failed upload and `--dry-run` record nothing.
  - A reused build already submitted to Google Play is not uploaded again, since Google Play takes each version code once: the CLI prints `Already on Google Play internal testing since <time> as 1.7.0 (66). Bump the build number to upload a new build.` and exits 0, and `--json` reports `submission.skipped: "already-submitted"` with the existing submission. A reused build Google Play's internal track has without a record, and Google Play's own refusal of a version code it already has, are skipped with the same line and record nothing; `@hot-updater/android-helper` throws it as `PlayVersionCodeUsedError`.
  - `@hot-updater/android-helper` exports `uploadToPlay`, `readBuiltApp`, `resolvePlayUploadServiceAccount`, `assertPlaySigned`, and `readBuiltPackageName`.

- bcc6f20: Pull requests get previews from a GitHub Action, `gronxb/hot-updater/actions/preview`, which reads its credentials through the config's `secrets` adapter, the job's environment by default. Each pull request gets its own channel (`pr-<number>`), and native builds that embed it, so an installed build opens the pull request's bundle on its first launch. For each platform the action builds a native build, which Hot Updater tracks, only when the registry has none on the pull request's channel for the project's fingerprint, or app version, then deploys the pull request's bundle there. It keeps one comment on the pull request, edited on every push: each platform's download and page links in the Console's Native builds tab, whether the run built or reused the native build, the bundle, the QR code of an APK's download when the Console serves it under `console-url`, and the install commands for an emulator or simulator, with a "Preview by hot-updater" line that `credit: false` turns off. When the pull request closes, it deletes the channel with its bundles and its native builds. iOS previews a Simulator app on a macOS runner. When a native build fails, the action uploads the CLI's build log as the `hot-updater-preview-build-log-<platform>` artifact. An Expo project sets the pull request's channel in its own `app.config.ts`, such as `channel: process.env.PREVIEW_CHANNEL ?? "production"` in the `@hot-updater/expo` plugin's options, with the job setting `PREVIEW_CHANNEL`.
  - `hot-updater native-build find -p <platform> [-c <channel>] [-s <scheme>] [--json]` prints the newest tracked native build that a build of the project would match: the fingerprint from the config's fingerprint inputs, or with the `appVersion` strategy, the version of the app the scheme builds, on the native project's default channel or `--channel`. With `--scheme`, the build must be the kind of artifact the scheme builds. No build prints `nativeBuild: null` and succeeds.
  - `hot-updater native-build ios|android --json` prints `{ dryRun, build, nativeBuild, registration, submission }` as the last line of its output: the build, with the channel and the fingerprint or app version its artifact embeds, its record (null for a Debug build or a dry run, with `registration.skipped` saying why), and the store it went to.
  - `hot-updater channel delete <channel> --native-builds` also deletes every native build that embeds the channel, each with its built-in bundle and its artifact in storage, then the channel. `--json` adds `deletedNativeBuildIds`.

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
- 32de3ce: Upload an iOS build to TestFlight with `hot-updater native-build ios --submit testflight`, or its shortcut `hot-updater testflight`.
  - `testflight` runs `native-build ios`'s build, which tracks it, and takes only `--scheme`: any other option or argument exits 1 naming the full command. Without `--scheme`, it builds the one `nativeBuild.ios` scheme TestFlight takes and says which; with several, it asks at a terminal, and in CI or without a terminal it exits listing them with the full command. With none, it says why each scheme is refused and how to add one.
  - The upload authenticates with an App Store Connect API key, the scheme's `signing.ascApiKey` or else the `secrets` adapter's `asc-api-key`, which the `HOT_UPDATER_ASC_KEY*` environment variables override. The key is resolved before the build adapter's prebuild and the build, and its temporary file is deleted when the upload ends.
  - It uses the App Store Connect API's build uploads: it finds the app by the `.ipa`'s bundle ID, reserves its version and build number, uploads the file in the parts App Store Connect asks for, with only the headers each part lists, commits it, and waits up to 30 minutes for App Store Connect to accept the build, printing the warnings and errors it reports. A build number App Store Connect already has is reported as one to raise.
  - Before the prebuild, the CLI refuses, saying why, a scheme App Store Connect would not take: a simulator build, a Debug configuration, code signing turned off (`CODE_SIGNING_ALLOWED` or `CODE_SIGNING_REQUIRED` left `NO` after the overrides the build applies: `extraParams` settings, then the scheme's `xcconfig` and each `-xcconfig` in `extraParams`, resolved from `ios/` with their `#include`s, the last unconditional assignment winning; a setting a condition such as `[sdk=iphoneos*]` also sets is left to the build), a scheme that only archives, or an `exportOptionsPlist` of another method than App Store Connect; one the prebuild writes is checked before the build. `testflight` skips such schemes when it picks one.
  - Once App Store Connect accepts the build, the CLI records the submission on the tracked build, `submitted_to: "testflight"` with the version and build number as `submitted_version` (`1.7.0 (66)`), and the Console's Native builds tab shows it. Only an upload the run made is recorded; a build still processing, a failed upload, and `--dry-run` record nothing. `uploadToTestFlight`'s result has `shortVersion` and `bundleVersion`.
  - A reused build already submitted to TestFlight is not uploaded again, since App Store Connect takes each build number once: the CLI prints `Already on TestFlight since <time> as 1.7.0 (66). Bump the build number to upload a new build.` and exits 0, so a rerun CI job succeeds, and `--json` reports `submission.skipped: "already-submitted"` with the existing submission. A reused build the store has without a record, found by its version and build number, and App Store Connect's own refusal of a build number it already has, from another upload or tool, are skipped with the same line and record nothing, since the store's build may be another artifact; `@hot-updater/apple-helper` throws it as `TestFlightBuildExistsError`.
  - `@hot-updater/apple-helper` exports `uploadToTestFlight`, `resolveTestFlightUploadKey`, and `assertTestFlightExportOptions`.
  - Tracking also takes the built-in bundle out of an `.ipa` whose app name contains `[`, `*`, or `?`, which `unzip` read as wildcards.

### Patch Changes

- 8c675a2: CLI prompts refuse to ask without a terminal instead of waiting: `keys export-public` names `-y` and `-p`, `keys remove`, `db migrate`, `db generate`, and `native-build ios|android` without `--scheme` name the option that skips the prompt, and every other prompt fails with an error. `native-build find` no longer runs the build adapter's prebuild, so a lookup leaves `ios/` and `android/` as they are: the Expo adapter reports the app version and channel `expo prebuild` would write from the Expo config (`nativeBuild.getNativeProjectValues`), and other adapters' native projects are read as they are. `hot-updater native-build delete <id>` deletes a registered native build, its built-in bundle, and its stored artifact, through core's new `deleteNativeBuild` and the admin API's `DELETE /native-builds/:id`.
- 84b21f0: `hot-updater doctor` lists every pending schema setting in one run. When core's schema and a plugin's were both behind, such as `schema.core` 1.0.0 and a plugin's missing setting, `SCHEMA_MIGRATION_PENDING` named only `schema.core`, and the plugin's appeared after core was migrated. The schema fence over a server's plugins now checks core's settings with theirs in the same single read, so its refusal, the 503 message, doctor, and the Console list every setting missing or different. The fence passes and fails as before, with no extra read.
- fbe5798: `hot-updater console` prints a link with a session made for that run, and the local Console answers only the browser that opened it, only at `localhost`, `127.0.0.1`, or `[::1]` on its port, and only changes sent from its own pages. Every Console, hosted or local, now lists TanStack Start's same-origin check for server functions explicitly, and every server function that changes something validates its input.
- f5cffc0: `hot-updater native-build ios|android`, and `buildAndroid` and `buildIos` without a `minBundleId`, issue the MIN_BUNDLE_ID the SDK's podspec script phase and Gradle task generate: the UUIDv7 of the build's millisecond with all-zero random bits (`<ts>-<ts>-7000-8000-000000000000`), instead of a platform byte and random bits. `createMinBundleId(nowMs?)` from `@hot-updater/cli-tools` takes no platform. Before a tracked build, the CLI reads the registry once and steps the ID 1 ms forward while a bundle holds it. Two builds that start in the same millisecond, such as an iOS and an Android job of one CI run, still get the same ID: the registry refuses the second registration, and `native-build` now says another build registered that built-in bundle first and to build again, instead of `native_builds: exists`. The build cache doesn't reuse this machine's cached build when another build registered its MIN_BUNDLE_ID, so building again issues a new one. `native-build import` and every reader keep accepting any UUIDv7, so artifacts an earlier CLI built, whose MIN_BUNDLE_ID has a platform byte, still import.
- 288f6a9: An iOS scheme with `installPods: true` installs its pods before `native-build ios` computes the native build key, and the build uses them as installed. The key then holds the `Podfile.lock` the pods resolved to, and `Pods/Manifest.lock`, so a project whose `ios/` the build adapter's prebuild generates, such as an Expo app, can reuse a build instead of always building; pods that resolve differently still rebuild. A generated (git-ignored) `project.pbxproj` counts by its structure, with its objects labelled in the order they are reached from the root object, since `pod install` integrates a freshly generated project with new random object IDs each time; its files, groups, targets, build phases, settings, and their order still count. `@hot-updater/apple-helper` exports `installPodsIfNeeded`.
- Updated dependencies [6276804]
- Updated dependencies [d7f02a6]
- Updated dependencies [8c675a2]
- Updated dependencies [28dfe97]
- Updated dependencies [e97d063]
- Updated dependencies [84b21f0]
- Updated dependencies [0050ff3]
- Updated dependencies [43b0a61]
- Updated dependencies [af33b56]
- Updated dependencies [98daf8d]
- Updated dependencies [fbe5798]
- Updated dependencies [1ad0ebe]
- Updated dependencies [89cd5ce]
- Updated dependencies [f5cffc0]
- Updated dependencies [288f6a9]
- Updated dependencies [79c81f6]
- Updated dependencies [4d8e0d2]
- Updated dependencies [ed37acf]
- Updated dependencies [6f9313b]
- Updated dependencies [bcc6f20]
- Updated dependencies [b78660b]
- Updated dependencies [4e4ddfb]
- Updated dependencies [f017e61]
- Updated dependencies [5e7a045]
- Updated dependencies [32de3ce]
  - @hot-updater/apple-helper@1.2.0-rc.0
  - @hot-updater/cli-tools@1.2.0-rc.0
  - @hot-updater/plugin-core@1.2.0-rc.0
  - @hot-updater/server@1.2.0-rc.0
  - @hot-updater/console@1.2.0-rc.0
  - @hot-updater/cloudflare@1.2.0-rc.0
  - @hot-updater/supabase@1.2.0-rc.0
  - @hot-updater/aws@1.2.0-rc.0
  - @hot-updater/firebase@1.2.0-rc.0
  - @hot-updater/azure@1.2.0-rc.0
  - @hot-updater/vercel@1.2.0-rc.0
  - @hot-updater/android-helper@1.2.0-rc.0
  - @hot-updater/protocol@1.2.0-rc.0
  - @hot-updater/bsdiff@1.2.0-rc.0

## 1.1.5

### Patch Changes

- @hot-updater/android-helper@1.1.5
  - @hot-updater/apple-helper@1.1.5
  - @hot-updater/bsdiff@1.1.5
  - @hot-updater/cli-tools@1.1.5
  - @hot-updater/console@1.1.5
  - @hot-updater/protocol@1.1.5
  - @hot-updater/server@1.1.5
  - @hot-updater/plugin-core@1.1.5

## 1.1.4

### Patch Changes

- Updated dependencies [7d009f9]
  - @hot-updater/console@1.1.4
  - @hot-updater/android-helper@1.1.4
  - @hot-updater/apple-helper@1.1.4
  - @hot-updater/bsdiff@1.1.4
  - @hot-updater/cli-tools@1.1.4
  - @hot-updater/protocol@1.1.4
  - @hot-updater/server@1.1.4
  - @hot-updater/plugin-core@1.1.4

## 1.1.3

### Patch Changes

- 84bffd7: `hot-updater doctor` now looks for `HotUpdater.bundleURL()` in `SceneDelegate` as well as `AppDelegate`, so apps that host React in a SceneDelegate are no longer reported as missing the iOS bundle provider.
- bab7654: The iOS app version reader now treats `${MARKETING_VERSION}` in `Info.plist` or `project.pbxproj` as unresolved, like `$(MARKETING_VERSION)`. Xcode substitutes both forms. Before, such a project resolved no default target app version, so `deploy` without `-t` stopped, and interactive `deploy` prefilled `1.0.0`; it now reads the version from the next source.
- @hot-updater/android-helper@1.1.3
  - @hot-updater/apple-helper@1.1.3
  - @hot-updater/bsdiff@1.1.3
  - @hot-updater/cli-tools@1.1.3
  - @hot-updater/console@1.1.3
  - @hot-updater/protocol@1.1.3
  - @hot-updater/server@1.1.3
  - @hot-updater/plugin-core@1.1.3

## 1.1.2

### Patch Changes

- 007e0c5: Require Node.js 22.23.4+, 24.22.1+, or 26.12.1+, the releases that fix CVE-2026-111497 in Node's Brotli decoder. Node.js 20 is end of life and gets no fix.

  Patch creation (`hot-updater patch` and the patches `deploy` creates) first checks each manifest against the bundle's recorded `manifestFileHash`, verifying a signed one with the configured signing public key, then checks every Hermes bundle it downloads against the manifest's SHA-256 hashes, a Brotli-compressed one before decoding it. Storage bytes that deploy did not upload no longer reach the Brotli decoder or a patch.

- Updated dependencies [007e0c5]
  - @hot-updater/cli-tools@1.1.2
  - @hot-updater/android-helper@1.1.2
  - @hot-updater/apple-helper@1.1.2
  - @hot-updater/bsdiff@1.1.2
  - @hot-updater/console@1.1.2
  - @hot-updater/protocol@1.1.2
  - @hot-updater/server@1.1.2
  - @hot-updater/plugin-core@1.1.2

## 1.1.1

### Patch Changes

- @hot-updater/android-helper@1.1.1
  - @hot-updater/apple-helper@1.1.1
  - @hot-updater/bsdiff@1.1.1
  - @hot-updater/cli-tools@1.1.1
  - @hot-updater/console@1.1.1
  - @hot-updater/protocol@1.1.1
  - @hot-updater/server@1.1.1
  - @hot-updater/plugin-core@1.1.1

## 1.1.0

### Minor Changes

- ffc0e23: Native builds embed their own fingerprint. A build step in the HotUpdater pod (or its Swift Package Manager plugin) and in the Android library writes the fingerprint into the binary before compiling, so a binary always carries the fingerprint of the native interface it was built from. `fingerprint create` no longer writes `HOT_UPDATER_FINGERPRINT_HASH` into `Info.plist` or `com.hotupdater.FINGERPRINT_HASH` into `AndroidManifest.xml`, and the native SDK no longer reads them.
  - `fingerprint.json` records the inputs each fingerprint came from: the build adapter and its fingerprint settings.
  - A Release build runs the new `npx hot-updater fingerprint hash -p <platform>`. It computes the fingerprint from those inputs without loading `hot-updater.config.ts`, so build machines need no deploy secrets.
  - A Debug build uses the hash `fingerprint.json` holds.
  - A `fingerprint.json` without `inputs`, written by an earlier `hot-updater`, is embedded as recorded with a warning, as is one whose build adapter is installed in a version without the new fingerprint export, so upgrading the React Native package alone doesn't break release builds.
  - The reverse, a `@hot-updater/react-native` that still reads the fingerprint from `Info.plist` and `AndroidManifest.xml`, makes `fingerprint create`, `deploy`, `doctor`, and the Expo config plugin stop and ask you to update it, instead of building an app with a stale fingerprint.
  - When the project changed after `fingerprint create`, the build still embeds the fingerprint it was built from and warns that `fingerprint.json` is stale.
  - An app without `fingerprint.json` builds with no fingerprint, as the appVersion strategy expects. Under appVersion, `doctor` reports a leftover `fingerprint.json` as `FINGERPRINT_JSON_UNUSED` (`doctor --fix` deletes it), `deploy` warns about it, the native build commands refuse to build, and the Expo config plugin removes it at prebuild.
  - Swift Package Manager builds always compute the fingerprint, since a package build plugin can't tell Debug from Release.
  - Set `HOT_UPDATER_APP_ROOT` (an Xcode build setting or environment variable, or a Gradle property) when the native projects are not in `<app>/ios` and `<app>/android`.
  - `HotUpdaterConfig`'s `fingerprintHash` and an instance's `HotUpdaterOptions.fingerprintHash` still take precedence over the embedded fingerprint. Named instances use the embedded fingerprint too, since every bundle comes from the project the build fingerprinted.

  doctor drops `MISSING_FINGERPRINT_HASH` and `FINGERPRINT_HASH_MISMATCH`, and the Expo config plugin writes `fingerprint.json` without injecting the hash.

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

- 8276eca: Fix OTA updates in brownfield apps that ship React Native as an XCFramework or AAR.
  - iOS: the bundle passed to `HotUpdater.bundleURL(bundle:)` now also serves reloads and crash recovery, so a rollback finds the XCFramework's embedded `main.jsbundle` and assets. Hot Updater reads `HOT_UPDATER_CHANNEL`, `HOT_UPDATER_FINGERPRINT_HASH` and `HOT_UPDATER_PUBLIC_KEY` from that bundle's `Info.plist` before the app's, and a runtime channel switch now outranks `HotUpdater.configure(channel:)`, as on Android.
  - Android: the Brotli decoder compiles into the SDK instead of a bundled jar, which AAR packaging dropped, so downloading an update no longer crashes a brownfield app with `NoClassDefFoundError`.
  - Android: a launch counts as able to show UI once a started activity shows a React Native view, not when any activity starts. A brownfield app that loads React Native with a native screen, and that the user closes without opening a React Native screen, keeps its update on the next start.
  - CLI: `channel set`, `fingerprint create` and `keys export-public` write into an empty `<application />` element, such as a brownfield library module's manifest.

- 2ca4389: Record the engine behind each fingerprint. `fingerprint.json` now stores the `@expo/fingerprint` version that computed each hash. When a different version computes a different hash, `doctor`, `deploy`, and `fingerprint create` report that the engine changed instead of listing source changes; `doctor` reports it as `FINGERPRINT_ENGINE_CHANGED`, which `doctor --fix` leaves to you. They also say how to keep updating builds already shipped: go back to that version. Existing hashes are unchanged: `doctor` warns `FINGERPRINT_ENGINE_UNRECORDED` for a `fingerprint.json` without engines, and `fingerprint create` or `doctor --fix` records the engine.
- Updated dependencies [7eaad78]
- Updated dependencies [60db3ea]
- Updated dependencies [99d0356]
  - @hot-updater/cli-tools@1.1.0
  - @hot-updater/plugin-core@1.1.0
  - @hot-updater/protocol@1.1.0
  - @hot-updater/android-helper@1.1.0
  - @hot-updater/apple-helper@1.1.0
  - @hot-updater/console@1.1.0
  - @hot-updater/server@1.1.0
  - @hot-updater/bsdiff@1.1.0

## 1.0.8

### Patch Changes

- @hot-updater/android-helper@1.0.8
  - @hot-updater/apple-helper@1.0.8
  - @hot-updater/bsdiff@1.0.8
  - @hot-updater/cli-tools@1.0.8
  - @hot-updater/console@1.0.8
  - @hot-updater/protocol@1.0.8
  - @hot-updater/server@1.0.8
  - @hot-updater/plugin-core@1.0.8

## 1.0.7

### Patch Changes

- @hot-updater/android-helper@1.0.7
  - @hot-updater/apple-helper@1.0.7
  - @hot-updater/bsdiff@1.0.7
  - @hot-updater/cli-tools@1.0.7
  - @hot-updater/console@1.0.7
  - @hot-updater/protocol@1.0.7
  - @hot-updater/server@1.0.7
  - @hot-updater/plugin-core@1.0.7

## 1.0.6

### Patch Changes

- 57a990d: Every native build now ships its own build time as `MIN_BUNDLE_ID`, on the same epoch millisecond clock as the bundle IDs `hot-updater deploy` issues, whether it is built in Xcode, with `xcodebuild`, with Gradle, or through the CLI. A bundle deployed before the native build is no longer applied to it on iOS (#1543).
  - iOS: a script phase in `HotUpdater.podspec` writes the value into a header before every compile of the pod. It replaces the compile time of `HotUpdater.mm` minus 26 hours, which stayed at the last compile of that file while DerivedData was reused, and the `HOT_UPDATER_MIN_BUNDLE_ID` Info.plist key. The `HOT_UPDATER_MIN_BUNDLE_ID` build setting still wins, and `hot-updater build:ios` no longer adds the Info.plist slot.
  - Android: a build task writes the value into a generated source on every build, replacing `BuildConfig.BUILD_TIMESTAMP` and `BuildConfig.MIN_BUNDLE_ID`. `-PMIN_BUNDLE_ID` still wins.
  - A `HOT_UPDATER_MIN_BUNDLE_ID` or `MIN_BUNDLE_ID` that is not a UUIDv7 fails the build.

  Run `pod install` and rebuild the native app.

- Updated dependencies [5702bf5]
- Updated dependencies [3135b1c]
  - @hot-updater/plugin-core@1.0.6
  - @hot-updater/protocol@1.0.6
  - @hot-updater/server@1.0.6
  - @hot-updater/apple-helper@1.0.6
  - @hot-updater/android-helper@1.0.6
  - @hot-updater/cli-tools@1.0.6
  - @hot-updater/console@1.0.6
  - @hot-updater/bsdiff@1.0.6

## 1.0.5

### Patch Changes

- Updated dependencies [1d3ac77]
  - @hot-updater/console@1.0.5
  - @hot-updater/android-helper@1.0.5
  - @hot-updater/apple-helper@1.0.5
  - @hot-updater/bsdiff@1.0.5
  - @hot-updater/cli-tools@1.0.5
  - @hot-updater/protocol@1.0.5
  - @hot-updater/server@1.0.5
  - @hot-updater/plugin-core@1.0.5

## 1.0.4

### Patch Changes

- 33bdc32: Keep Vercel bundles in a private Blob store only. `vercelBlobStorage` no longer takes `access`: it works with a private store, and devices download through signed URLs that expire, issued only to requests with a valid API key. `hot-updater init` lists and creates private stores only. A project that init set up with a public store needs a private one: rerun `hot-updater init`, which warns about the saved public store and asks before replacing it, and select or create a private store (a non-interactive run uses `HOT_UPDATER_VERCEL_BLOB_STORE_NAME` once it names a private or new store). Bundles deployed to the public store stop downloading until you deploy them again. Remove `access` from `vercelBlobStorage` in `hot-updater.config.ts`; `HOT_UPDATER_VERCEL_BLOB_ACCESS` is no longer read.
- 33bdc32: `@hot-updater/vercel` re-exports `postgres`, so a managed Vercel project installs only `@hot-updater/vercel`. `hot-updater init` writes `import { postgres, vercelBlobStorage } from "@hot-updater/vercel"` and, on a rerun, moves an existing `postgres` import from `@hot-updater/postgres` there. You can then remove `@hot-updater/postgres` from the app's devDependencies.
- Updated dependencies [33bdc32]
  - @hot-updater/cli-tools@1.0.4
  - @hot-updater/android-helper@1.0.4
  - @hot-updater/apple-helper@1.0.4
  - @hot-updater/bsdiff@1.0.4
  - @hot-updater/console@1.0.4
  - @hot-updater/protocol@1.0.4
  - @hot-updater/server@1.0.4
  - @hot-updater/plugin-core@1.0.4

## 1.0.3

### Patch Changes

- 67dae2e: The CLI keeps an `AndroidManifest.xml` as it is when it writes Hot Updater's meta-data. `fingerprint create`, `keys export-public`, `channel set` and `keys remove` used to parse the manifest and build it again, which dropped every XML comment and reformatted the whole file, so one command left a diff across the app's manifest. The CLI now replaces the `android:value` of the matching `<meta-data>` under `<application>` in place, or adds the element as the last child indented like its siblings, and removing a key takes only its line. Comments, attribute layout, indentation, line endings and the order of elements stay as they were.
- 1a38fc5: The CLI writes an `Info.plist` back in the layout Xcode uses. `fingerprint create`, `keys export-public`, `channel set` and `keys remove` rebuilt the plist with the root `<dict>` indented one level under `<plist>`, while Xcode keeps it at column 0, so one key changed every line of the file and dropped its trailing newline. When the existing file has its root at column 0, element lines under `<plist>` now lose that extra tab, and a file whose root is already indented, as 1.0.2 wrote it, stays indented. Text of multi-line values stays as it is and the trailing newline is kept, so writing one key into an Xcode-written Info.plist no longer shifts its other lines. Lines the plist package does not round-trip still change; for example, an empty `<string></string>` becomes `<string/>` and XML comments are dropped.
- Updated dependencies [407ec2c]
  - @hot-updater/cli-tools@1.0.3
  - @hot-updater/android-helper@1.0.3
  - @hot-updater/apple-helper@1.0.3
  - @hot-updater/bsdiff@1.0.3
  - @hot-updater/console@1.0.3
  - @hot-updater/protocol@1.0.3
  - @hot-updater/server@1.0.3
  - @hot-updater/plugin-core@1.0.3

## 1.0.2

### Patch Changes

- ddfb139: Add the Azure provider, `@hot-updater/azure`: `azureBlobStorage` keeps bundles in Azure Blob Storage and serves them through SAS URLs, and `cosmosDatabase` runs Hot Updater's database in one Azure Cosmos DB for NoSQL container, with `migrateCosmosDatabase` to create it and write the schema settings. `hot-updater init` sets up Azure with the Azure CLI: it creates a storage account, a serverless Cosmos DB account with strong consistency, and a Flex Consumption Function App, migrates the database, deploys the Hot Updater Function, and creates the client API key. `hot-updater agent infra setup` and `hot-updater infra scaffold` take `--provider azure`.
- d4d1d07: Add Vercel as a managed provider. `hot-updater init` can now set up Hot Updater on Vercel: it selects the team, creates or reuses the project, selects or creates a Blob store (private by default) and connects it to the project, and takes a Postgres database connected to the project, a new Neon database from the Vercel Marketplace, or a connection URL. It then migrates the database, deploys the prebuilt Hot Updater Function to production, and issues the first API key. The new `@hot-updater/vercel` package exports `vercelBlobStorage`, and the generated config uses `postgres` from `@hot-updater/postgres`. `hot-updater agent infra` and `infra scaffold` take `--provider vercel`.
- Updated dependencies [ddfb139]
- Updated dependencies [d4d1d07]
  - @hot-updater/cli-tools@1.0.2
  - @hot-updater/android-helper@1.0.2
  - @hot-updater/apple-helper@1.0.2
  - @hot-updater/bsdiff@1.0.2
  - @hot-updater/console@1.0.2
  - @hot-updater/protocol@1.0.2
  - @hot-updater/server@1.0.2
  - @hot-updater/plugin-core@1.0.2

## 1.0.1

### Patch Changes

- 367e60c: Support a named Firestore database. `firebaseDatabase` and `migrateFirebaseDatabase` take a `databaseId` option, which defaults to `(default)`. Firebase `hot-updater init` asks which database to use when the project has more than one, saves the choice as `HOT_UPDATER_FIREBASE_DATABASE_ID`, and uses it for the index deploy, the schema settings, the generated config, and the `hot-updater-v1` Function. The agent scaffold takes the database ID as a deployment input.
- f838b56: `deploy` no longer guesses the target app version of a project that builds several apps: when Xcode app targets or Android product flavors declare different versions, it asks for `-t` and lists them, and `app-version` shows them. `build:ios`, `build:android`, and their `run:` commands read the version of the app target or flavor their scheme builds.
- Updated dependencies [4e7c9c9]
  - @hot-updater/protocol@1.0.1
  - @hot-updater/console@1.0.1
  - @hot-updater/android-helper@1.0.1
  - @hot-updater/cli-tools@1.0.1
  - @hot-updater/server@1.0.1
  - @hot-updater/plugin-core@1.0.1
  - @hot-updater/apple-helper@1.0.1
  - @hot-updater/bsdiff@1.0.1

## 1.0.0

### Major Changes

- adb0e40: Hot Updater 1.0, the first stable release of v1. Deploys create Releases that the server compiles into one cacheable Release Catalog per app scope, and `createHotUpdater` runs a storage adapter, a database adapter, and plugins such as Insights, Remote Config, and client API keys. v1 runs on new infrastructure and needs a new native app build: follow the [upgrade guide](https://hot-updater.dev/docs/guides/upgrade-to-v1) and [BREAKING_CHANGES.md](https://github.com/gronxb/hot-updater/blob/main/BREAKING_CHANGES.md) to move from v0.

### Patch Changes

- Updated dependencies [adb0e40]
  - @hot-updater/android-helper@1.0.0
  - @hot-updater/apple-helper@1.0.0
  - @hot-updater/bsdiff@1.0.0
  - @hot-updater/cli-tools@1.0.0
  - @hot-updater/console@1.0.0
  - @hot-updater/plugin-core@1.0.0
  - @hot-updater/protocol@1.0.0
  - @hot-updater/server@1.0.0

## 1.0.0-rc.47

### Patch Changes

- ccf3e2f: Remove the `EMBEDDED` Release kind. Every Release points at a Bundle, and a device goes back to its built-in bundle through the `BUILTIN` selection.
  - `getActiveUpdateState().kind` is `"BUNDLE"` or `"BUILTIN"`, and `transitionKind` no longer includes `"USE_EMBEDDED"`; no server creates bundle-less Releases.
  - `ReleaseKind` and `ReleaseRow.kind` are `"BUNDLE"`. The `kind` column and the `kind` field of catalog descriptors stay, so no migration is needed and catalogs are unchanged.
  - `parseReleaseCatalog` accepts only `BUNDLE` descriptors that carry a `bundleId`.
  - `compileReleaseCatalog` rejects an enabled Release without a Bundle with `INVALID_RELEASE`.

- 7132080: A database whose settings carry `schema.core` without `schema.engine` is no longer refused separately: the schema fence and `hot-updater db migrate` treat it like any unmigrated database. A v0 database is still refused, with the advice to create a new empty database and run `hot-updater db migrate`. `standaloneRepository` no longer sends a `v` query parameter with admin requests, and `hot-updater init` no longer looks for a `hotUpdater.plugins.ts` file or, on Firebase and Supabase, for collections and tables outside the storage engine's layout. A plugin with a `kind` key fails with the unknown-key error.
- Updated dependencies [5891d9b]
- Updated dependencies [ccf3e2f]
- Updated dependencies [7132080]
- Updated dependencies [ccf3e2f]
  - @hot-updater/plugin-core@1.0.0-rc.47
  - @hot-updater/protocol@1.0.0-rc.47
  - @hot-updater/server@1.0.0-rc.47
  - @hot-updater/console@1.0.0-rc.47
  - @hot-updater/cli-tools@1.0.0-rc.47
  - @hot-updater/android-helper@1.0.0-rc.47
  - @hot-updater/apple-helper@1.0.0-rc.47
  - @hot-updater/bsdiff@1.0.0-rc.47

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

- 19be90f: Remove options and messages left over from v0.
  - `drizzleAdapter` no longer takes `schema`, which it ignored. TypeScript now reports it: delete it.
  - `MigrateOptions` no longer has `mode`: every migration already ran from the schema. Delete `mode: "from-schema"` from `migrateToLatest` calls.
  - `@hot-updater/js` is no longer published. It only copied `semverSatisfies` and `filterCompatibleAppVersions` from `@hot-updater/plugin-core`.
  - Messages say what is wrong without naming a version:
    - `createHotUpdater` refuses a `database` that is not a Hot Updater database adapter, such as `kyselyAdapter(...)` or `postgres(...)`.
    - The Kysely, Drizzle, and Prisma adapters list the supported providers.
    - `standaloneRepository` refuses a server whose `/version` does not report admin API protocol 2, and asks for the path where the server mounts `handlers.admin`.
    - Firebase `init` refuses an incompatible Function `hot-updater-v1` with its own message.
    - `hot-updater doctor` names `com.hotupdater.FINGERPRINT_HASH` in `AndroidManifest.xml` when it does not match `fingerprint.json`.
  - The Expo config plugin no longer deletes `hot_updater_*` strings from `strings.xml`. They have no effect: prebuild writes the manifest meta-data the app reads.

- Updated dependencies [47638d6]
- Updated dependencies [19be90f]
  - @hot-updater/cli-tools@1.0.0-rc.46
  - @hot-updater/protocol@1.0.0-rc.46
  - @hot-updater/plugin-core@1.0.0-rc.46
  - @hot-updater/server@1.0.0-rc.46
  - @hot-updater/console@1.0.0-rc.46
  - @hot-updater/android-helper@1.0.0-rc.46
  - @hot-updater/apple-helper@1.0.0-rc.46
  - @hot-updater/bsdiff@1.0.0-rc.46

## 1.0.0-rc.45

### Patch Changes

- @hot-updater/android-helper@1.0.0-rc.45
  - @hot-updater/apple-helper@1.0.0-rc.45
  - @hot-updater/bsdiff@1.0.0-rc.45
  - @hot-updater/cli-tools@1.0.0-rc.45
  - @hot-updater/console@1.0.0-rc.45
  - @hot-updater/protocol@1.0.0-rc.45
  - @hot-updater/server@1.0.0-rc.45
  - @hot-updater/plugin-core@1.0.0-rc.45

## 1.0.0-rc.44

### Minor Changes

- 92971a0: Export official plugin factories from `hot-updater/plugins` and generate explicit plugin arrays in managed configs, matching the server and client configuration pattern.

  Reuse official server factories through the CLI entry when rerunning init, preserve plugin files still needed by existing configs, and propagate Firebase config write failures. Report config shapes that could override the generated plugin list instead of claiming a successful merge.

### Patch Changes

- 13d2119: `createHotUpdater` requires one storage adapter, `storage: s3Storage({ ... })`, the same adapter `hot-updater.config.ts` uploads with, and `hotUpdater.storage` is that adapter. Startup throws without it. `setupDatabaseTestSuite`'s `createHttpClient` receives one adapter too.

  `clientAccess` takes only `"public"`. Options that no longer exist, in `createHotUpdater` and `hot-updater.config.ts`, are left to TypeScript instead of runtime checks.

  A Release Catalog path with a channel name in place of its key, or a malformed fingerprint hash, answers `400` instead of `500`. `standaloneRepository` stops with a message when `baseUrl` points at the client mount instead of `handlers.admin`. `hot-updater init` no longer writes a storage call that uses a helper it removed.

- 13d2119: Storage adapters return the URL devices download from, and the server no longer serves downloads itself.
  - `s3Storage` and `r2Storage` presign their download URLs again, as in v0: a URL signed with the adapter's credentials that expires in an hour, so devices download from the private bucket. `downloadUrlSigningKey` is removed from both. `s3Storage`'s `getDownloadUrl`, such as `cloudFrontDownloadUrl(...)`, still replaces the presigned URL.
  - `r2Storage` from `@hot-updater/cloudflare/worker` takes `accountId` and `credentials`, R2's S3-compatible credentials, in place of `downloadUrlSigningKey`, and presigns the same URLs; without them it has no `getDownloadUrl`, as a Console needs. The managed Worker reads them from the `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` secrets and the `ACCOUNT_ID` variable, which `hot-updater init` sets in place of `STORAGE_DOWNLOAD_URL_SIGNING_KEY`.
  - The client handler's `GET /storage/:token/:signature` route is removed, with `createStorageDownloadUrl`, `createStorageDownloadPath`, and `parseStorageDownloadPath` from `@hot-updater/plugin-core`. `getDownloadUrl` returns an absolute `http(s)` URL, which the storage adapter test suite requires, and the React Native SDK takes only absolute artifact URLs.

- 92971a0: Consolidate the official server plugin factories, types, and helpers under `@hot-updater/server/plugins`. Replace the individual `plugins/api-keys`, `plugins/insights`, and `plugins/remote-config` imports with the shared entry.
- Updated dependencies [92971a0]
- Updated dependencies [13d2119]
- Updated dependencies [13d2119]
- Updated dependencies [92971a0]
  - @hot-updater/cli-tools@1.0.0-rc.44
  - @hot-updater/server@1.0.0-rc.44
  - @hot-updater/console@1.0.0-rc.44
  - @hot-updater/plugin-core@1.0.0-rc.44
  - @hot-updater/android-helper@1.0.0-rc.44
  - @hot-updater/apple-helper@1.0.0-rc.44
  - @hot-updater/bsdiff@1.0.0-rc.44
  - @hot-updater/protocol@1.0.0-rc.44

## 1.0.0-rc.43

### Patch Changes

- Updated dependencies [23c14fa]
  - @hot-updater/server@1.0.0-rc.43
  - @hot-updater/cli-tools@1.0.0-rc.43
  - @hot-updater/console@1.0.0-rc.43
  - @hot-updater/android-helper@1.0.0-rc.43
  - @hot-updater/apple-helper@1.0.0-rc.43
  - @hot-updater/bsdiff@1.0.0-rc.43
  - @hot-updater/protocol@1.0.0-rc.43
  - @hot-updater/plugin-core@1.0.0-rc.43

## 1.0.0-rc.42

### Minor Changes

- 72fd2de: The CLI manages Remote Config and reads Insights, as the Console does, on the server `hot-updater api-key` finds: `database` and `plugins` in `hot-updater.config.ts`, the server's admin routes through `standaloneRepository`, or the server file passed last.
  - **`hot-updater remote-config`:** `show` (`--version-number` for a published version), `versions`, `publish <file>`, `rollback <version>`, and `preview`. `publish` takes a template or what `show --json` printed, validates it, lists what it adds, changes, and removes, and asks first (`-y` to skip, `--dry-run` to stop before it). It publishes after the version the file was read at, or `--expected-version`, so a newer publish is never replaced, and the active template publishes nothing. `preview` evaluates the active template, a version, or a `--file` for a device's platform, channel, app version, cohort, fingerprint, and time.
  - **`hot-updater insights`:** `overview`, `failures`, `events`, and `installations`, with the Console's words: a bundle's Downloaded, Launched, and Crashed reports, update failure rates and their stages and reasons, reports by outcome or installation, and installations by install or user ID. `--bundle` takes the ID shown in the Console and reads the bundle's platform and channel; `--window` is `24h`, `7d`, or `30d`.
  - **Plugins:** `createRemoteConfigAdminApi(fetchAdmin)` is Remote Config over a server's admin routes, answering as `RemoteConfigApi` does, and `createInsightsAdminReads(fetchAdmin)` and `createInsightsReads(api)` are the Insights reads over the admin routes or the plugin's API. The Console and the CLI share them.

### Patch Changes

- Updated dependencies [72fd2de]
- Updated dependencies [1451d4a]
  - @hot-updater/console@1.0.0-rc.42
  - @hot-updater/server@1.0.0-rc.42
  - @hot-updater/cli-tools@1.0.0-rc.42
  - @hot-updater/android-helper@1.0.0-rc.42
  - @hot-updater/apple-helper@1.0.0-rc.42
  - @hot-updater/bsdiff@1.0.0-rc.42
  - @hot-updater/protocol@1.0.0-rc.42
  - @hot-updater/plugin-core@1.0.0-rc.42

## 1.0.0-rc.41

### Patch Changes

- Updated dependencies [545f059]
- Updated dependencies [545f059]
- Updated dependencies [545f059]
  - @hot-updater/protocol@1.0.0-rc.41
  - @hot-updater/server@1.0.0-rc.41
  - @hot-updater/console@1.0.0-rc.41
  - @hot-updater/plugin-core@1.0.0-rc.41
  - @hot-updater/android-helper@1.0.0-rc.41
  - @hot-updater/cli-tools@1.0.0-rc.41
  - @hot-updater/apple-helper@1.0.0-rc.41
  - @hot-updater/bsdiff@1.0.0-rc.41

## 1.0.0-rc.40

### Patch Changes

- Updated dependencies [53e9fca]
  - @hot-updater/console@1.0.0-rc.40
  - @hot-updater/android-helper@1.0.0-rc.40
  - @hot-updater/apple-helper@1.0.0-rc.40
  - @hot-updater/bsdiff@1.0.0-rc.40
  - @hot-updater/cli-tools@1.0.0-rc.40
  - @hot-updater/protocol@1.0.0-rc.40
  - @hot-updater/server@1.0.0-rc.40
  - @hot-updater/plugin-core@1.0.0-rc.40

## 1.0.0-rc.39

### Patch Changes

- 2071bc6: Release health's **Adoption** draws each bundle's downloads as a dashed line beside its launches, solid, in the bundle's color, per interval, and its table shows both counts for the period. After a forced update the two lines nearly meet; otherwise launches follow downloads as apps restart. The **Per interval** and **Cumulative** switch is gone, with its `adoptionTotal` URL value. The Console uses one vocabulary, Downloaded, Launched, and Crashed: event lists name `UPDATE_APPLIED` **Launched** and `RECOVERED` **Crashed**, Release health's crash count is **Crashed**, a download waiting for a restart is **Not launched yet**, and the Release health and bundle tooltips are a sentence or two.

  A download that a launch or crash implied, when its download report never arrived, now counts in the bundle's `UPDATE_DOWNLOADED` outcome counter too, in the hour of that launch or crash. So `countEventSeries` and `countEvents` for a bundle's downloads cover the downloads its release counts, and the reporting overview's `downloadedReports` counts them in whole hours. The launch or crash stays the row, so a download filter's counter can exceed the download rows its hour holds. No table changes: no migration is needed.

- Updated dependencies [2071bc6]
  - @hot-updater/console@1.0.0-rc.39
  - @hot-updater/server@1.0.0-rc.39
  - @hot-updater/cli-tools@1.0.0-rc.39
  - @hot-updater/plugin-core@1.0.0-rc.39
  - @hot-updater/android-helper@1.0.0-rc.39
  - @hot-updater/apple-helper@1.0.0-rc.39
  - @hot-updater/bsdiff@1.0.0-rc.39
  - @hot-updater/protocol@1.0.0-rc.39

## 1.0.0-rc.38

### Patch Changes

- bbbdd8c: Insights no longer miscounts two report orders. A launch report made, by its event ID, before the installation's latest report is late even after a later report, such as a user switch or the next day's launch, replaced the apply it preceded: it no longer counts a launch and a download of the bundle the installation left, or moves the installation back to it. A download that repeats the installation's pending one, from the same bundle to the same bundle, counts nothing, so a download reported twice before its launch counts once and the launch implies no second one. Both are kept in history as late reports, as before; the Console notes that the installation had already downloaded or run the bundle. Event IDs are made on the device, so a device whose clock jumps back has its launch reports judged late until its clock passes its latest report.
- Updated dependencies [bbbdd8c]
  - @hot-updater/console@1.0.0-rc.38
  - @hot-updater/server@1.0.0-rc.38
  - @hot-updater/cli-tools@1.0.0-rc.38
  - @hot-updater/plugin-core@1.0.0-rc.38
  - @hot-updater/android-helper@1.0.0-rc.38
  - @hot-updater/apple-helper@1.0.0-rc.38
  - @hot-updater/bsdiff@1.0.0-rc.38
  - @hot-updater/protocol@1.0.0-rc.38

## 1.0.0-rc.37

### Patch Changes

- 5a5dd3e: Keep an `UNCHANGED` report as an event when it changes what its installation runs, and count each release's downloads, launches, and crashes once per installation. The server compares a report with the installation's latest report and keeps it when it is the installation's first report (**First seen**), a new app version or native build (**App updated**), another bundle with no apply report for it (**Launched**), another Release of the bundle it already runs (**Release adopted**), or another channel. A user switch, and a launch that changes nothing, keep no event, so daily launches cost what they did. All Events and installation history show each change once, with what came before.

  A release's launches count its apply reports and the kept reports that moved an installation onto it when no apply report came. A launch or crash whose download report never arrived counts that download too. A download or apply that arrives after its installation already ran the bundle, as a reload can deliver it, counts nothing and moves no latest report. Once every installation restarts, a release's downloads equal its launches plus crashes. The Console's Bundles list shows **Downloaded**, **Launched**, and **Crashed**, and the bundle detail shows downloads not launched yet; a release of the built-in bundle shows no downloads. Release health's **Adoption** counts launches per interval or as a running total, and the crash rate is crashes ÷ (launches + crashes). `InsightsBundleEventFilter` accepts `UNCHANGED`, under a new `on:` key that `UNCHANGED` rows kept by older servers never used, so those count as no launch. No table changes: no migration is needed.

- Updated dependencies [5a5dd3e]
  - @hot-updater/console@1.0.0-rc.37
  - @hot-updater/server@1.0.0-rc.37
  - @hot-updater/cli-tools@1.0.0-rc.37
  - @hot-updater/plugin-core@1.0.0-rc.37
  - @hot-updater/android-helper@1.0.0-rc.37
  - @hot-updater/apple-helper@1.0.0-rc.37
  - @hot-updater/bsdiff@1.0.0-rc.37
  - @hot-updater/protocol@1.0.0-rc.37

## 1.0.0-rc.36

### Patch Changes

- c527bb2: Report installations on the built-in bundle. A client plugin's context has `minBundleId`, the ID of the bundle the native build ships, and the Insights client sends it with each report. Insights counts an installation that runs its build's built-in bundle again in the new `insights_builtin_distribution` gauge, by the release it runs and the bundle's ID, and `getAppUsage` returns `builtinBundleId` with each `bundleDistribution` row. The Console's **Distribution** shows **Built-in app** with the bundle ID under its app version, where it showed **Unknown bundle**, and event and installation details mark the built-in bundle. Reports from SDKs that do not send `minBundleId` count as before.

  The Insights schema version stays 1.0.0 while the 1.0.0 baseline gains the `insights_builtin_distribution` table; existing tables don't change. On SQL databases, create it as the baseline does (Supabase prefixes it with `hot_updater_v1_` and enables row level security); Drizzle and Prisma projects regenerate their schema with `hot-updater db generate` and migrate it. On AWS the DynamoDB policy allows the new partition: rerun `hot-updater init`. Firestore and MongoDB need no change. Installations count in it from their first report after the upgrade.

- Updated dependencies [c527bb2]
  - @hot-updater/protocol@1.0.0-rc.36
  - @hot-updater/console@1.0.0-rc.36
  - @hot-updater/server@1.0.0-rc.36
  - @hot-updater/android-helper@1.0.0-rc.36
  - @hot-updater/cli-tools@1.0.0-rc.36
  - @hot-updater/plugin-core@1.0.0-rc.36
  - @hot-updater/apple-helper@1.0.0-rc.36
  - @hot-updater/bsdiff@1.0.0-rc.36

## 1.0.0-rc.35

### Patch Changes

- @hot-updater/android-helper@1.0.0-rc.35
  - @hot-updater/apple-helper@1.0.0-rc.35
  - @hot-updater/bsdiff@1.0.0-rc.35
  - @hot-updater/cli-tools@1.0.0-rc.35
  - @hot-updater/console@1.0.0-rc.35
  - @hot-updater/protocol@1.0.0-rc.35
  - @hot-updater/server@1.0.0-rc.35
  - @hot-updater/plugin-core@1.0.0-rc.35

## 1.0.0-rc.34

### Patch Changes

- 48241d4: Remove crash exit reasons. Android 11 and later reported only why the previous process exited, such as `CRASH` or `ANR`, with no stack trace or message, and iOS reported nothing, so they could not show what crashed. The SDK no longer reads `ApplicationExitInfo` or sends `previousProcessExit`. `AppReadyResult` and `UpdateError` drop the field, Insights keeps no exit-reason rows, `getUpdateFailures` drops `recoveries`, and the Console drops **Crashes by exit reason**. A bundle's crash count in Release health is no longer a link. The server still accepts reports from SDKs that send the field and ignores it. Update failure reads count only the stages a failure records, so exit-reason rows already stored are ignored until they expire.

  The Insights schema version is 1.0.0, as core's is, while the 1.0.0 baseline changes in place: set the `schema.insights` setting to `1.0.0`. The Console's tooltips are shorter.

- Updated dependencies [48241d4]
  - @hot-updater/protocol@1.0.0-rc.30
  - @hot-updater/console@1.0.0-rc.34
  - @hot-updater/server@1.0.0-rc.34
  - @hot-updater/android-helper@1.0.0-rc.34
  - @hot-updater/cli-tools@1.0.0-rc.34
  - @hot-updater/plugin-core@1.0.0-rc.30
  - @hot-updater/apple-helper@1.0.0-rc.34

## 1.0.0-rc.33

### Patch Changes

- 9fe6dfd: Count each release's applies instead of its active days. A release's lifetime counters count its `UPDATE_APPLIED` reports in `applies`, where they counted each installation once for each UTC day it launched the release, and `getReleaseActivity` returns `applies` instead of `launches`. A launch report changes no release or channel counter, and a recovery counts only the crash on the bundle it left, not an apply of the bundle it returned to. The Bundles list and detail show **Applied** instead of **Active days**, and rate known crashes over applied plus known crashes, as Release health does. Hourly and daily counters drop `launches` and `failed_updates`, which no read summed, and a daily launcher costs about 36 DynamoDB write units a day instead of 38.

  The Insights schema moves to 1.4.0 in the 1.0.0 baseline. A server, a Console, and a database on different Insights schemas refuse each other, so migrate the database and upgrade both together. On SQL databases, drop the `launches` and `failed_updates` columns of `insights_overview` and `insights_overview_daily`, and rename `launches` on `insights_overview_lifetime` to `applies`, set to 0 (Supabase prefixes these tables with `hot_updater_v1_`); Drizzle and Prisma projects regenerate their schema with `hot-updater db generate` and migrate it. Then set the `schema.insights` setting to `1.4.0`; DynamoDB, Firestore, and MongoDB need only the setting. Applied counts the apply reports received from then on, since the old counts included days an installation only relaunched.

- Updated dependencies [9fe6dfd]
  - @hot-updater/console@1.0.0-rc.33
  - @hot-updater/server@1.0.0-rc.33
  - @hot-updater/cli-tools@1.0.0-rc.33
  - @hot-updater/plugin-core@1.0.0-rc.29
  - @hot-updater/android-helper@1.0.0-rc.33
  - @hot-updater/apple-helper@1.0.0-rc.33

## 1.0.0-rc.32

### Patch Changes

- Updated dependencies [005fc2c]
- Updated dependencies [384a5b6]
  - @hot-updater/console@1.0.0-rc.32
  - @hot-updater/protocol@1.0.0-rc.29
  - @hot-updater/android-helper@1.0.0-rc.32
  - @hot-updater/cli-tools@1.0.0-rc.32
  - @hot-updater/server@1.0.0-rc.32
  - @hot-updater/plugin-core@1.0.0-rc.29
  - @hot-updater/apple-helper@1.0.0-rc.32

## 1.0.0-rc.31

### Patch Changes

- d846556: Rebuild Release health around one question: is a newly deployed bundle taking over, and is it crashing? It follows the two newest bundle deployments of the channel and platform, or a focused release and the one deployed before it, on the card's timeline (hourly for 24h, every six hours for 7d, daily for 30d), with each deployment marked and one color per bundle. Add a bundle from the ten newest deployments, up to four, or remove one; the choice and the tab are kept in the URL. **Adoption** charts the installations that applied each bundle, with its update failures; **Crashes** charts the launches that crashed on each bundle and recovered, with its crash rate, and recommends rolling a bundle back once it crashes for 5% of at least 20 installations that tried it. **Roll back** disables its release, as the bundle details do. A bundle's update failures or crashes open the Failures details on it, and View adoption on a bundle opens Release health on it.

  Remove what the old Release health used: the Bundle share chart and its daily observation heads, the Downloads and Adoption tabs, the metrics row, and the Launch failures tab. Insights drops `getDistributionHistory`, the `bundle_daily_heads` and `insights_distribution_history` tables, the per-report daily head writes, the per-hour release launch sketches, launches on hourly and daily rows (a release keeps its lifetime count), and the unread recent-events index; a repeated launch on the same UTC day writes nothing again, and a daily launcher costs about 38 DynamoDB write units a day instead of 58. `getReleaseActivity` reads lifetime release counts only, without `coverage`. The DynamoDB batching gate holds each event's batched aggregate writes to a budget instead of a ratio to the now cheaper transactional writes. It adds `countEventSeries`, a bundle filter's event counts per interval read from the hourly counts it already keeps. The Insights schema returns to the 1.0.0 baseline, version 1.2.0, without the 1.0.0-rc.30 migrations. Upgrade the Console and the plugin together: a 1.0.0-rc.30 Console cannot read Release health from this plugin. A database already migrated to 1.0.0-rc.30 records Insights 1.3.0, which this server refuses: set its `schema.insights` setting back to `1.2.0`, and on SQL databases drop the `bundle_daily_heads` and `insights_distribution_history` tables.

- Updated dependencies [d846556]
  - @hot-updater/console@1.0.0-rc.31
  - @hot-updater/server@1.0.0-rc.31
  - @hot-updater/cli-tools@1.0.0-rc.31
  - @hot-updater/plugin-core@1.0.0-rc.28
  - @hot-updater/android-helper@1.0.0-rc.31
  - @hot-updater/apple-helper@1.0.0-rc.31

## 1.0.0-rc.30

### Patch Changes

- 0c884b7: Show daily observed bundle shares in Release health while retaining its scope totals and moving launch failures to a separate chart tab. Count each reporting installation once on its day's last observed running bundle, preserve previous days, and include built-in and unknown bundles in the denominator. Show gaps without observations, the unfinished current day, app-version filtering, and tooltip counts.

  Insights schema 1.3.0 adds daily observation heads and distribution history. Migrate the server and Console together; history begins after upgrade and is not backfilled. The shared model and HTTP conformance suites cover daily replacement and historical preservation, and the versioned infrastructure guide documents each provider's upgrade.

- Updated dependencies [0c884b7]
- Updated dependencies [541f0ec]
  - @hot-updater/console@1.0.0-rc.30
  - @hot-updater/server@1.0.0-rc.30
  - @hot-updater/cli-tools@1.0.0-rc.30
  - @hot-updater/plugin-core@1.0.0-rc.28
  - @hot-updater/android-helper@1.0.0-rc.30
  - @hot-updater/apple-helper@1.0.0-rc.30

## 1.0.0-rc.29

### Patch Changes

- 80bb792: Attach the latest catalog or artifact HTTP response to existing Insights reports without adding requests or changing launch/failure deduplication. Preserve successful, cached, and failed response text with a bounded body and its original observation timestamp. Console exposes the response from event and installation details and alongside error investigation. No database migration is required.
- Updated dependencies [80bb792]
  - @hot-updater/protocol@1.0.0-rc.28
  - @hot-updater/console@1.0.0-rc.29
  - @hot-updater/android-helper@1.0.0-rc.29
  - @hot-updater/cli-tools@1.0.0-rc.29
  - @hot-updater/server@1.0.0-rc.29
  - @hot-updater/plugin-core@1.0.0-rc.28
  - @hot-updater/apple-helper@1.0.0-rc.29

## 1.0.0-rc.28

### Patch Changes

- Updated dependencies [b412f41]
  - @hot-updater/console@1.0.0-rc.28
  - @hot-updater/server@1.0.0-rc.28
  - @hot-updater/cli-tools@1.0.0-rc.28
  - @hot-updater/android-helper@1.0.0-rc.28
  - @hot-updater/apple-helper@1.0.0-rc.28

## 1.0.0-rc.27

### Patch Changes

- Improve the readability of Console update failures by grouping check metrics separately, emphasizing nonzero failures, and making stage/reason details easier to scan. Preserve all report data and rate calculations. Prepare all public Hot Updater packages together as 1.0.0-rc.27.
- Updated dependencies
  - @hot-updater/android-helper@1.0.0-rc.27
  - @hot-updater/apple-helper@1.0.0-rc.27
  - @hot-updater/bsdiff@1.0.0-rc.27
  - @hot-updater/cli-tools@1.0.0-rc.27
  - @hot-updater/console@1.0.0-rc.27
  - @hot-updater/plugin-core@1.0.0-rc.27
  - @hot-updater/protocol@1.0.0-rc.27
  - @hot-updater/server@1.0.0-rc.27

## 1.0.0-rc.26

### Patch Changes

- c9cfed7: Restore the rc.14 Insights metric layout in bundle rows and details while preserving current data, rates, links, and download failure reporting. Release all public Hot Updater packages together as 1.0.0-rc.26.
- Updated dependencies [c9cfed7]
  - @hot-updater/android-helper@1.0.0-rc.26
  - @hot-updater/apple-helper@1.0.0-rc.26
  - @hot-updater/bsdiff@1.0.0-rc.26
  - @hot-updater/cli-tools@1.0.0-rc.26
  - @hot-updater/console@1.0.0-rc.26
  - @hot-updater/plugin-core@1.0.0-rc.26
  - @hot-updater/protocol@1.0.0-rc.26
  - @hot-updater/server@1.0.0-rc.26

## 1.0.0-rc.25

### Patch Changes

- c9cfed7: Release the legacy Hermes fallback correction at 1.0.0-rc.25 with all public Hot Updater packages on the same RC.
- Updated dependencies [c9cfed7]
  - @hot-updater/android-helper@1.0.0-rc.25
  - @hot-updater/apple-helper@1.0.0-rc.25
  - @hot-updater/bsdiff@1.0.0-rc.25
  - @hot-updater/cli-tools@1.0.0-rc.25
  - @hot-updater/console@1.0.0-rc.25
  - @hot-updater/plugin-core@1.0.0-rc.25
  - @hot-updater/protocol@1.0.0-rc.25
  - @hot-updater/server@1.0.0-rc.25

## 1.0.0-rc.24

### Patch Changes

- cc34295: Resolve Expo config and fingerprint dependencies from the target app with Node's package resolver. Remove Expo config file-path fallbacks, honor evaluated dynamic and platform-specific JavaScript engine settings, and preserve config and dependency errors.

  Resolve React Native metadata through its package manifest and legacy Hermes binaries from the app's dependencies, including hoisted installations.

- c9cfed7: Release the project-scoped Expo, fingerprint, React Native, and Hermes resolution fixes at 1.0.0-rc.24 so projects can install the same RC of every Hot Updater package.
- Updated dependencies [cc34295]
- Updated dependencies [c9cfed7]
  - @hot-updater/cli-tools@1.0.0-rc.24
  - @hot-updater/android-helper@1.0.0-rc.24
  - @hot-updater/apple-helper@1.0.0-rc.24
  - @hot-updater/bsdiff@1.0.0-rc.24
  - @hot-updater/console@1.0.0-rc.24
  - @hot-updater/plugin-core@1.0.0-rc.24
  - @hot-updater/protocol@1.0.0-rc.24
  - @hot-updater/server@1.0.0-rc.24

## 1.0.0-rc.23

### Patch Changes

- c9cfed7: Release with the Expo SDK 58 config fix at 1.0.0-rc.23 so projects can install the same RC of every Hot Updater package.
- Updated dependencies [c9cfed7]
  - @hot-updater/android-helper@1.0.0-rc.23
  - @hot-updater/apple-helper@1.0.0-rc.23
  - @hot-updater/bsdiff@1.0.0-rc.23
  - @hot-updater/cli-tools@1.0.0-rc.23
  - @hot-updater/console@1.0.0-rc.23
  - @hot-updater/plugin-core@1.0.0-rc.23
  - @hot-updater/protocol@1.0.0-rc.23
  - @hot-updater/server@1.0.0-rc.23

## 1.0.0-rc.22

### Minor Changes

- 4e1cb07: `hot-updater app-version` is back. It prints the app version each native project builds, and `--json` prints `{ "android": ..., "ios": ... }`, with `null` for a platform it can't read, for release scripts that pass the version to `deploy -t`. `doctor` still shows the same versions in its native status.

### Patch Changes

- Updated dependencies [c9cfed7]
  - @hot-updater/android-helper@1.0.0-rc.22
  - @hot-updater/apple-helper@1.0.0-rc.22
  - @hot-updater/bsdiff@1.0.0-rc.22
  - @hot-updater/cli-tools@1.0.0-rc.22
  - @hot-updater/console@1.0.0-rc.22
  - @hot-updater/plugin-core@1.0.0-rc.22
  - @hot-updater/protocol@1.0.0-rc.22
  - @hot-updater/server@1.0.0-rc.22

## 1.0.0-rc.21

### Minor Changes

- 5ec6796: CLI commands exist only for user workflows. Checks move into `hot-updater doctor`, which can now repair what it finds with `--fix`, and plumbing commands are removed, with no aliases:
  - `hot-updater app-version` is removed. `doctor` shows each platform's app version in its native status, as `appVersion` in `--json`.
  - Bare `hot-updater channel` shows help. `doctor` shows the native default channels, and `channel set` stays.
  - Bare `hot-updater fingerprint` shows help. Under the fingerprint update strategy, `doctor` compares `fingerprint.json` with the project's fingerprint and reports `FINGERPRINT_JSON_STALE` with the sources that changed, or `FINGERPRINT_GENERATION_FAILED`. `fingerprint create` stays.
  - `hot-updater db catalog preflight` and `db catalog rebuild` are removed. When `hot-updater.config.ts` sets `database`, `doctor` opens it once per run and checks every scope that has a catalog row or a release:
    - `RELEASE_CATALOG_STALE` is a catalog that differs from a rebuild from its releases;
    - `RELEASE_CATALOG_IDENTITY_MISSING` is a scope whose releases have no catalog row, which devices get 404 for. The row must be restored from backup;
    - `RELEASE_CATALOG_CHECK_FAILED` is a scope core cannot compile, reported beside the other scopes' results;
    - a database doctor cannot reach is the warning `RELEASE_CATALOGS_UNCHECKED`, never a failure.
  - `hot-updater bundle preflight` is removed. `bundle update --dry-run` takes the same options and validates the update and shows the projected catalog, without saving or asking.
  - `hot-updater bundle artifact delete` is removed. Deleting a release deletes its artifact record when no other release uses it, whether the CLI, the console, or the admin API deletes it.
    - Every patch to or from that artifact goes with it, so a device running the deleted bundle downloads its next update in full.
    - `bundle delete` says so, and its `--json` output names the artifact in `deletedArtifactId`.
    - Stored files stay until `storage prune`.
    - Artifact records that an earlier release candidate's `bundle delete` left behind show up in `doctor` as `UNREFERENCED_ARTIFACTS`. `doctor --fix` deletes them, and `storage prune` then reclaims their files.
  - `hot-updater patch` no longer takes the hidden `--bundle-id` and `--base-bundle-id` aliases. Use `--artifact-id` and `--base-artifact-id`.
  - `hot-updater keys export-public` no longer takes `-i, --input <path>`. It exports the configured signing key.
  - `hot-updater build:android` needs `EXPERIMENTAL`, like `build:ios`, `run:android`, and `run:ios`.

  `hot-updater doctor --fix` runs the repairs doctor can make itself:
  - it rebuilds stale release catalogs from their releases;
  - it deletes the artifact records no release uses;
  - it writes what `fingerprint create` writes, where it differs;
  - it writes what `keys export-public --yes` writes.

  It names every write, in the output and in `details.fixes`, and checks again.

  It skips native files that `expo prebuild` generates. It never removes a public key: an issue with more than one remedy, such as `ORPHAN_PUBLIC_KEY`, stays report-only. When it wrote a native file, it ends by asking for a native rebuild.

  `@hot-updater/protocol` exports `parseReleaseCatalog`, the check a client runs on a fetched release catalog, with `hasExpectedReleaseCatalogScope`, `ExpectedReleaseCatalogScope`, `MAX_RELEASE_CATALOG_WIRE_BYTES`, and `getUtf8ByteLength`. The React Native update client and doctor's server checks both run it.

  `@hot-updater/test-utils` exports `storeBundles`, which stores bundles with no release through the storage engine.

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

- 0d8d03b: `hot-updater doctor` warns `MISSING_CLIENT_PLUGIN` when a server plugin's client plugin is missing from the app: for each client plugin that the plugins in `hot-updater.config.ts` name and no app source imports, it says to import it and pass it to `HotUpdater.init({ plugins })`. It checks a project that installs `@hot-updater/react-native` and sets `database`, and warns `CLIENT_PLUGINS_UNCHECKED` when it cannot load the config's database and plugins.
- ab04e15: Plugins no longer add `hot-updater` commands. `PluginCli` keeps `clientCredential` and `clientPlugin`, the metadata that `hot-updater init`, `hot-updater doctor`, and the agent scaffold read, and its `commands` is removed, with no replacement:
  - These names are removed from every package: `PluginCommand`, `PluginCommandArgument`, `PluginCommandOption`, `PluginCommandContext`, `PluginCommandUi`, and `PluginTableColumn`, which rc.20 exported from `@hot-updater/server/plugins`, and `pluginCommandsOf` and `PluginCommandEntry`, which rc.20 exported from `@hot-updater/server/db`.
  - `createHotUpdater` refuses a plugin whose `cli` holds `commands`, or any key other than `clientCredential` and `clientPlugin`, with `HotUpdaterConfigError`.
  - The CLI no longer looks for plugin commands, and `hot-updater --help` no longer lists **Plugin commands**.

  `hot-updater api-key create|list|revoke` is a built-in command again: `create --name <name>`, `list` with `--json`, and `revoke <id>` with `-y`, each with an optional trailing `[serverPath]`. It manages keys through `apiKeys()` over the first of:
  - the server file `serverPath` names, such as `src/hotUpdater.ts` in a server project;
  - `database` and `plugins` in `hot-updater.config.ts`, when the config sets `database`;
  - `src/hotUpdater.*` or `src/db.*`.

  When those plugins lack `apiKeys()`, it says to add it. With `database: standaloneRepository(...)`, it says to run the command in the server project with the server file's path, since the admin API serves no API key routes. The `cli` of `apiKeys()` from `@hot-updater/plugin-api-keys` holds only its `clientCredential`.

- b92970f: Each managed provider package has one `./init` entry, which is the provider's whole init:
  - `initProvider`: the inputs init asks for and checks;
  - `runInit`.

  `./iac` is removed. `./init` no longer exports these input helpers:
  - `@hot-updater/aws`: `AWS_AUTH_MODES`, `AwsAuthMode`, `isAwsAuthMode`, `AWS_REGION_VALUES`, `AwsRegionValue`, `isAwsRegionValue`;
  - `@hot-updater/firebase`: `isFirebaseRegion`, `isFirebaseProjectId`;
  - `@hot-updater/supabase`: `SUPABASE_DATABASE_PASSWORD_PROJECT_ID_ENV_KEY`, `SUPABASE_REGION_VALUES`, `SupabaseRegion`, `isSupabaseRegion`, `isSupabaseFunctionName`.

  Update `hot-updater` together with the provider packages:
  - A `hot-updater` CLI at rc.20 or older imports `./iac`, which these provider packages no longer export, so it fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
  - `hot-updater`'s optional peer dependencies on the provider packages now follow its own version, so package managers warn about a mismatch.
  - `hot-updater init` names the version to install and stops:
    - before it edits any file, when the provider package the project has is one whose `./init` has no `runInit` (provider packages up to rc.20);
    - before it creates or changes any resource, when the provider package still fails to load once init has installed its packages.

  `hot-updater init` bundles no provider code. It installs the chosen provider package, imports that package's `./init`, checks the provider's inputs, and then runs `runInit`:
  - **`--from-env-file`** reports problems in two stages:
    - a missing build adapter or provider, before init installs packages;
    - every missing provider input, once init has installed the provider package and before it creates or changes any resource.
  - **`hot-updater init --help` and `hot-updater infra scaffold`** don't need any provider package installed. They read each provider's inputs from the infrastructure templates, which the CLI's build records.

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
- eebe617: The "Next step" link that `hot-updater init` prints after it sets up AWS, Cloudflare, Firebase, or Supabase opens the provider guide at "Step 3: Add HotUpdater to your project". The old links named headings that the guides do not have, so they opened at the top of the page.
- 48cdd14: When no native build scheme is configured, the experimental native build commands (`build:android`, `build:ios`, `run:android`, and `run:ios`, available with `EXPERIMENTAL` set) say to add one under `nativeBuild.<platform>` in `hot-updater.config.ts` instead of linking to the Native Build docs page, which is removed until native builds are ready.
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

- 61fcd51: `@hot-updater/server` is the runtime host: its root holds `createHotUpdater`, its types, the handlers and `toNodeHandler`, and its other entries are the built-in adapters (`./adapters/*`) and plugins (`./plugins/insights`, `./plugins/api-keys`). The storage engine, the database adapter kit, and core's schema move to `@hot-updater/plugin-core`, the kit adapters and plugins build on, and test code moves to `@hot-updater/test-utils`.
  - `@hot-updater/server/database`, `@hot-updater/server/node`, `@hot-updater/server/plugins`, and `@hot-updater/server/plugins/insights/testing` are removed:
    - Import from `@hot-updater/plugin-core` what you imported from `@hot-updater/server/database` or `@hot-updater/server/plugins`.
    - Import `toNodeHandler` from `@hot-updater/server`.
    - Import the Insights suites from `@hot-updater/test-utils`.
  - From `@hot-updater/server/db`:
    - `createMeasuredDatabase`, `MeasuredDatabase`, and `MeasuredDatabaseOptions` move to `@hot-updater/test-utils`.
    - `targetBaseCandidateKey` and `EngineSqlOptions` move to `@hot-updater/plugin-core`, beside `parseBaseCandidateKey`.
    - `settingsStatements` is private.
  - `createEngine` now has the signature `createEngine(database, { plugins, now })`. It takes a database as `createEngineDatabase` returns it, and returns `{ core, database(plugin), flush, dispose }`. rc.18's `createEngine({ adapter, schema, maxPageSize, verify, retry })` from `@hot-updater/server/database` is gone. A transaction's retries are the database's `retry` (`createEngineDatabase({ retry })`), and verify mode is `verifyAdapter(adapter)`.
  - These rc.18 names now exist in no package, because they are the storage engine's internals:
    - `aggregateBatchingModule`, `CheckIndex`, `checkSchemaFence`, `classifySqlError`, `CliFor`, `compareTuples`, `createDatabaseEngine`;
    - `DATABASE_MAX_MULTI_VALUES`, `DATABASE_MAX_QUERY_LIMIT`, `DatabaseEngine`, `DatabaseEngineOptions`, `DatabaseTestState`, `DatabaseValueError`;
    - `ENGINE_SCHEMA_KEY`, `ENGINE_SCHEMA_VERSION`, `InstanceFor`, `isMissingSchemaError`, `MAX_SHARDS`, `migrateSchema`, `normalizeStoredValue`;
    - `ReadRange`, `ResolvedReference`, `resolveSchema`, `SchemaModule`, `settingsStatements`, `SHARD_COLUMN`, `validateSchema`, `withSchemaFence`.
  - No package has an internal entry: `@hot-updater/plugin-core/internal`, `@hot-updater/plugin-insights/internal`, and `@hot-updater/plugin-api-keys/internal` are removed, and `@hot-updater/plugin-insights/testing` too. A package uses another only through its public API. `InsightsBadRequestError`, which Insights' API throws for an input it refuses, is exported from `@hot-updater/plugin-insights/server`.
  - `@hot-updater/plugin-core` exports `createEngine(database, { plugins, now })`, the storage engine as `createHotUpdater` runs it: core's tables and the plugins', the plugins' settings rows behind the schema fence, expired rows pruned during writes, and batched aggregates. `meterReads(database)` meters any database on the engine, a provider's included, for adapter cost analysis. `database.measureReads(read)` reports what a call read at the adapter and at the engine. Aggregate batching's compaction and flush reads during the call count.
  - An `EngineDatabase` takes an optional `retry`, which `createEngineDatabase` also takes: how a transaction that conflicts with another write runs again, with `onRetry` to observe each rerun. A store many writers contend on can take more attempts.
  - `MemoryAdapterOptions` keeps only `tablePrefix`.
  - `@hot-updater/plugin-core` also exports what an adapter, a provider's tooling, or a plugin outside it needs: `SETTINGS_TABLE`, `aggregateBatchingTables`, and `encodeKvKey` for setups and access policies; `createEngineSqlMigrator`, `createSettingsMigrator`, `sqlTableShapes`, and `quoteSql` for ORM adapters; `DATABASE_VERSION_COLUMN`, `rowKey`, `findPhysicalIndex`, and `findPhysicalColumn` for an adapter that is neither SQL nor key-value; `compareUtf8` and `isDatabaseJsonObject` for plugins; the types `verifyAdapter` returns and throws; and the option and tooling types of its public functions. `createEngineDatabase` takes `readSettings` for an adapter that reads stored settings itself.
  - `CoreSchema`, core's tables as `createEngine`'s `core` handle types them, is part of `@hot-updater/plugin-core`'s API: a change to core's schema releases `@hot-updater/plugin-core` and ships with the migration `schema.core` versions.
  - `@hot-updater/test-utils` uses the other packages only through their public API. `createMeasuredDatabase(adapter, plugins, { now, storage })` returns a promise of core, the plugins' APIs, their `clientAuth`, and `measureReads`, from `createHotUpdater` over `meterReads({ name, adapter: verifyAdapter(adapter) })`; `now` is the plugins' clock. `setupReadBudgetTestSuite` takes no `server`, and its `createAdapter` gets `SETTINGS_TABLE` among its `tables`. `createPluginTestHarness` and `setupAggregateBatchingTestSuite` run on `createEngine` and take no `engine`; the harness runs no retention passes. It also exports `createMemoryKeyValueStore`, the database fixtures, and the Insights suites, and `@hot-updater/test-utils/node` the SQL test executors and `createD1TestDatabase(db, statements)`, a D1 database over `node:sqlite`. `@hot-updater/server` and `@hot-updater/plugin-insights` are optional peer dependencies.
  - Published packages leave out specs and test helpers:
    - `@hot-updater/server` publishes `dist` only.
    - `@hot-updater/cloudflare`, `@hot-updater/supabase`, and `@hot-updater/react-native` leave their specs out of the source they ship.
    - `@hot-updater/react-native` also leaves out its Android unit tests.
    - `@hot-updater/cloudflare`'s D1 test database moves to `@hot-updater/test-utils/node`.
  - `@hot-updater/postgres` and `@hot-updater/console` import the storage engine kit and the plugin types from `@hot-updater/plugin-core`.

- bb57f25: What fills one slot of a config is now an adapter: storage, build, database, and signing. What you list in `plugins` stays a plugin: server plugins, client plugins, and the Sentry, Datadog, and BugSnag integration plugins that wrap a build adapter.
  - `@hot-updater/plugin-core`: `StoragePlugin` is `StorageAdapter`, `createStoragePlugin` is `createStorageAdapter`, `StoragePluginWith` is `StorageAdapterWith`, `CreateStoragePluginOptions` is `CreateStorageAdapterOptions`, `BuildPlugin` is `BuildAdapter`, `BuildPluginConfig` is `BuildAdapterConfig`, `BasePluginArgs` is `BuildAdapterArgs`, `BundleSigningPlugin` is `BundleSigningAdapter`, and `DatabasePluginInputError` is `DatabaseAdapterInputError`. There are no aliases.
  - `@hot-updater/bare`, `@hot-updater/expo`, and `@hot-updater/rock`: their options types are `BareAdapterConfig`, `ExpoAdapterConfig`, and `RockAdapterConfig`.
  - The CLI, the server, and the console say "storage adapter", "build adapter", "database adapter", and "signing adapter" in their messages, such as `Storage adapter "<name>" does not implement <operation>.` and `No storage adapter for protocol: <protocol>`. `hot-updater init --build <adapter>` names its option accordingly.

  Package names and factory names do not change: `s3Storage()`, `r2Storage()`, `bare()`, `expo()`, `rock()`, `postgres()`, and the rest are configured as before.

- Updated dependencies [c9cfed7]
- Updated dependencies [5ec6796]
- Updated dependencies [ab04e15]
- Updated dependencies [ab04e15]
- Updated dependencies [d500c97]
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
  - @hot-updater/android-helper@1.0.0-rc.21
  - @hot-updater/apple-helper@1.0.0-rc.21
  - @hot-updater/bsdiff@1.0.0-rc.21
  - @hot-updater/cli-tools@1.0.0-rc.21
  - @hot-updater/console@1.0.0-rc.21
  - @hot-updater/protocol@1.0.0-rc.21
  - @hot-updater/plugin-core@1.0.0-rc.21
  - @hot-updater/server@1.0.0-rc.21

## 1.0.0-rc.20

### Minor Changes

- 9cd555b: The plugin that provides `clientAuth` describes the credential an app sends in `cli.clientCredential`: its label, header, environment variable, and how to generate and provision it. `@hot-updater/server/db` exports `clientAuthOf`, `generateClientCredential`, and `provisionClientCredential`, which read it from a plugin list.

  Managed init provisions the app's credential through the provider's plugins and prints `HotUpdater.init` with that credential's header, or with no `requestHeaders` when client routes are public; `@hot-updater/cli-tools` exports `renderAppSetup` and `printAppSetup` for it. AWS CloudFront cache and origin-request policies key on the client-route policy's `varyHeaders` instead of a fixed `x-api-key`.

  Agent and infrastructure scaffolds record the server's `clientAuth` in `manifest.json` and render their instructions from it. The helper is `app/provision-client-credential.mjs` with `app/database.config.ts`, and it saves `app/client-credential.local`. `hot-updater doctor` reads the credential's header and variable from the scaffold, and skips the 401 check when client routes are public.

- 9cd555b: A server plugin names the client plugin an app adds to `HotUpdater.init`'s `plugins` in `cli.clientPlugin`, as `{ module, name }`; `insights()` names `insights` from `@hot-updater/react-native/plugins/insights`. `createHotUpdater` checks them at startup: each names an export the app can import, not a reserved word, `App`, or `HotUpdater`, and no two plugins name one export from different modules. `@hot-updater/server/db` exports `clientPluginsOf`, which reads them from a plugin list. Managed init passes them to `printAppSetup`, which imports them and adds them to `plugins`, and agent scaffolds record them in `manifest.json` and render the app code in their instructions from them.
- 9cd555b: Server plugins add their own `hot-updater` commands through a `cli` field on `definePlugin`. A command runs `run` with the plugin's API over a database the CLI opens itself; with a `standaloneRepository` config, it asks for the server config that exports `hotUpdater`. The CLI looks for plugin commands only when it has no core command of that name: in a server config the command line names, then `hotUpdater.plugins.ts` over the database in `hot-updater.config.ts`, then `hot-updater.config.ts`, `src/hotUpdater.ts`, or `src/db.ts`. `hot-updater --help` and the unknown-command error list them under **Plugin commands**, marked with their plugin's id.

  `hot-updater api-key create|list|revoke` now comes from `apiKeys()`, with the same arguments and options, and also runs in managed projects through `hotUpdater.plugins.ts`. `@hot-updater/server/db` exports `serverPluginsOf` and `pluginCommandsOf` for tooling.

- 9cd555b: Remove the `hot-updater codemod` command and its `client-access` codemod. It only moved `clientAccess` objects from earlier release candidates to plugins, and release candidates keep no compatibility with each other: recreate the RC database, and update the server, app, and console together.

### Patch Changes

- e696e69: The 1.0.0 infrastructure upgrade notes that `hot-updater infra scaffold` writes, and the AWS agent setup, list the DynamoDB policy's batched Insights log partitions, `aggregate_log_0` to `aggregate_log_7` and `aggregate_lease`, and its `BatchWriteItem` permission. The IAM policy changed: rerun `hot-updater init`, and recreate release candidate data if needed. The notes' Insights check reads overview summaries through the Console or the admin API on DynamoDB and Firestore, since a read applies pending batches first.
- 9574287: Cache a scope's missing Release Catalog like a catalog. The `404` for a scope with no catalog yet, such as a store version before its first OTA release, now uses the catalog's `public, max-age=0, s-maxage=5` and is marked `x-hot-updater-catalog: none`, so a shared cache absorbs those update checks instead of passing each one to the origin. Other `404`s stay `private, no-store` and unmarked. `hot-updater doctor` and the agent server check accept the marked `404` as an empty catalog and still reject an unmarked one.
- a084eda: `hot-updater db generate --sql` writes core's tables and those of the server's plugins, which it finds as plugin commands find theirs: in the server config the first argument names, in `hotUpdater.plugins.ts`, or in a default server config. It names the file it read them from; without one, it says so and writes core's tables only. The agent scaffold's Firestore `database.config.ts` exports `migrate(plugins)`, which `provision-client-credential.mjs` runs with the plugins `hotUpdater.plugins.ts` lists.
- d7f1688: The `HotUpdater.init` snippet that managed `init` prints now adds the Insights client plugin, `plugins: [insights()]` from `@hot-updater/react-native/plugins/insights`, since an app reports to Insights only with it. The CLI's agent setup instructions add the same plugin.
- 14188a7: Update packaged infrastructure instructions for the stable release, remove
  release-candidate migration procedures, and correct provider verification order
  and schema prerequisites.
- 530cca5: Each provider deletes rows past their table's retention with no scheduler. DynamoDB deletes items by Time to Live on `_ttl`: `migrateDynamoDB`, `hot-updater db migrate`, and the managed AWS setup turn it on, and `hot-updater infra scaffold` writes `dynamodb/enable-ttl.json`. Firestore deletes documents by a TTL policy on `expireAt`, declared in `firestore.indexes.json`. Cloudflare D1 and Supabase delete them during writes, in bounded batches, within D1's query limit for one Worker invocation and through Supabase's apply RPC. The D1 and Supabase schemas add the Insights daily and lifetime tables and the indexes pruning walks. A deployment from a 1.0.0 release candidate recreates its database and updates the server, app, and console together.
- Updated dependencies [e696e69]
- Updated dependencies [e696e69]
- Updated dependencies [e696e69]
- Updated dependencies [e696e69]
- Updated dependencies [e696e69]
- Updated dependencies [9574287]
- Updated dependencies [9cd555b]
- Updated dependencies [9cd555b]
- Updated dependencies [9cd555b]
- Updated dependencies [1ddd5fc]
- Updated dependencies [9a6715f]
- Updated dependencies [a084eda]
- Updated dependencies [530cca5]
- Updated dependencies [959ba94]
- Updated dependencies [b317d49]
- Updated dependencies [d7f1688]
- Updated dependencies [1ddd5fc]
- Updated dependencies [9cd555b]
- Updated dependencies [530cca5]
- Updated dependencies [b317d49]
- Updated dependencies [9cd555b]
- Updated dependencies [9a6715f]
- Updated dependencies [a084eda]
- Updated dependencies [530cca5]
- Updated dependencies [b317d49]
- Updated dependencies [9a6715f]
- Updated dependencies [a084eda]
- Updated dependencies [530cca5]
- Updated dependencies [b317d49]
  - @hot-updater/aws@1.0.0-rc.18
  - @hot-updater/firebase@1.0.0-rc.18
  - @hot-updater/plugin-core@1.0.0-rc.17
  - @hot-updater/server@1.0.0-rc.18
  - @hot-updater/cli-tools@1.0.0-rc.17
  - @hot-updater/cloudflare@1.0.0-rc.18
  - @hot-updater/supabase@1.0.0-rc.18
  - @hot-updater/console@1.0.0-rc.20
  - @hot-updater/android-helper@1.0.0-rc.17
  - @hot-updater/apple-helper@1.0.0-rc.17

## 1.0.0-rc.19

### Patch Changes

- 038c804: Move `createBundleDiff` from `@hot-updater/server/db` to its own entry, `@hot-updater/server/diff`. The `db` entry no longer loads bsdiff's WebAssembly, so a console that uses it builds for Cloudflare Workers.
- Updated dependencies [038c804]
- Updated dependencies [038c804]
- Updated dependencies [038c804]
  - @hot-updater/console@1.0.0-rc.19
  - @hot-updater/server@1.0.0-rc.17
  - @hot-updater/aws@1.0.0-rc.17
  - @hot-updater/cloudflare@1.0.0-rc.17
  - @hot-updater/firebase@1.0.0-rc.17
  - @hot-updater/supabase@1.0.0-rc.17

## 1.0.0-rc.18

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

- d482b13: Add `hot-updater codemod client-access [paths...]`, which moves `createHotUpdater` calls from the 1.0 release candidates' `clientAccess` objects to plugins.
  - **Rewrites:** `clientAccess: { type: "public" }` becomes `clientAccess: "public"`. `clientAccess: { type: "api-key", headerName? }` is removed, and `apiKeys()` joins `plugins`, with the same `headerName` when one was set. A call without `plugins` gets `insights()`, which the release candidates ran by default. Missing imports from `@hot-updater/server/plugins/api-keys` and `@hot-updater/server/plugins/insights` are added, as `require` calls in CommonJS files.
  - **Edits in place:** the command parses each file with OXC and changes only the spans it rewrites, so formatting and comments survive. Calls that already use `clientAccess: "public"` or `plugins` stay as they are, so it can run again.
  - **Reports:** a file with a call it cannot rewrite safely, such as a `clientAccess` or `plugins` value held in a variable or options built with a spread, is reported with its line and left unchanged, and the command exits with code 1.
  - **Paths:** it takes files, directories, or globs, and defaults to the current directory without `node_modules`, `dist`, and `build`. `--dry-run` prints a unified diff and writes nothing.

- 7ba867c: Run the Drizzle adapter on the new storage engine. `drizzleAdapter({ db, provider })` keeps its signature.
  - **Engine:** reads and writes go through the shared SQL core over the Drizzle database's own driver. `db` may also be a function that returns the database on first use.
  - **Drivers:** the first use checks that the driver can run an interactive transaction. The supported drivers are node-postgres, postgres-js, PGlite, and Neon over WebSockets for PostgreSQL; mysql2 for MySQL; and libSQL, better-sqlite3, or bun:sqlite for SQLite. Other drivers are refused with `DrizzleTransactionUnsupportedError`. Sync SQLite drivers run one statement at a time and begin transactions with `BEGIN IMMEDIATE`.
  - **Schema:** `hot-updater db generate` writes the engine's tables as a Drizzle schema for `drizzle-kit push`. Every column is typed exactly as the SQL schema declares it.
  - **Migrations:** after `drizzle-kit push`, `hot-updater db migrate` now runs for Drizzle and writes only the settings rows. It asks for the tables when they are missing and refuses a pre-engine database.
  - **Schema fence:** the adapter fences its schema, so handlers answer 503 until `db migrate` has run.
  - **Unused options:** the `schema` option is accepted and ignored; it is for drizzle-kit. The `transaction` option is gone: every write runs in a transaction.

- d482b13: Create third-party plugins' tables with `hot-updater db`.
  - **Tooling:** `hot-updater db migrate` and `db generate` read the server's `plugins`. Besides the built-in tables, they create each third-party plugin's tables under its id and write its `schema.<id>` settings row last. Kysely's SQL, Drizzle's schema, Prisma's models, MongoDB's collections, and the Supabase and D1 migrations include them; DynamoDB and Firestore need only the settings row.
  - **Fence:** a server on a fenced database also checks each third-party plugin's `schema.<id>` row before its first read, and answers 503 until `db migrate` writes it.
  - **Any engine database:** `createEngineDatabase` gives an adapter with `migrations` the migrator `hot-updater db migrate` runs. The command now works for the `postgres` provider, DynamoDB, Firestore, D1's REST database, and custom adapters, besides the Kysely, Drizzle, Prisma, and MongoDB adapters.
  - **Supabase:** `supabaseDatabase` from `@hot-updater/supabase` generates a migration in `supabase/migrations` with the plugin tables, their row-level security, and an apply RPC that may reach them. Its adapter no longer offers to create tables, since the RPC runs no DDL, so `db migrate` points to `db generate`.
  - **D1:** the REST `d1Database` generates a Wrangler migration in `migrations`, and `db migrate` applies the same schema through the Cloudflare API.
  - **Names:** a third-party plugin may not take a built-in plugin's id, or a table name that resolves to a built-in table, such as an `api` plugin's `keys` table.
  - **SQL core:** `migrations.apply` also creates the write guard table for an executor with `batch`.
  - **Types:** `SchemaGenerator` and `DatabaseTooling.createMigrator` take a `ToolingTarget` (`{ schema, settings }`, exported from `@hot-updater/server/db`); `builtInTarget` from `@hot-updater/server/database` is the target without third-party plugins.
  - **CLI:** `db generate` skips a migration identical to one already in its directory.

- aee193e: Run the Prisma adapter on the new storage engine. `prismaAdapter({ prisma, provider })` keeps its signature; SQL Server is refused.
  - **Engine:** reads and writes go through the shared SQL core, with Prisma's raw queries and interactive transactions. Prisma's P2010 and P2034 errors carry the database's code, so constraints and write conflicts are classified as with other drivers. A SQLite transaction takes the write lock with its first statement, as `BEGIN IMMEDIATE` would.
  - **Schema:** `hot-updater db generate` merges the engine's tables into `prisma/schema.prisma` as models with keys and named indexes, and no relations; the engine keeps references itself. Fields that start with an underscore are mapped, such as `hu_v` to `_v`. On MySQL, ASCII keys are `VarBinary`, which keeps them within InnoDB's key limit.
  - **Migrations:** after `prisma db push` or `prisma migrate`, `hot-updater db migrate` now runs for Prisma. It sets the collations Prisma cannot declare (`COLLATE "C"` on PostgreSQL and binary UTF-8 on MySQL), then writes the settings rows.
  - **Schema fence:** the adapter fences its schema, so handlers answer 503 until `db migrate` has run.
  - **JSON parameters:** PostgreSQL JSON parameters are cast to `jsonb`, since Prisma binds strings as text.
  - **Booleans:** a stored `0n` or `1n` reads as a boolean, as Prisma returns SQLite `BIGINT` values.

- 228b6c7: Remove the legacy database contract. Every database runs on the storage engine, and core, its plugins, and the admin API are the only way to its data. Release candidate databases are recreated, not converted.
  - **Databases:** a provider returns an `EngineDatabase`, `{ name, adapter, dispose? }`, with `provider`, `createMigrator`, and `generateSchema` for `hot-updater db` where it has them. `createEngineDatabase({ name, adapter })` from `@hot-updater/server/database` puts the adapter behind the schema fence with the built-in settings; `builtInSchema`, `builtInSettings`, and `migrateBuiltInSchema` are the built-in tables, their settings rows, and their migration. `DatabasePlugin`, `createDatabasePlugin`, `createDatabaseClient`, the model and commit types, `commitReleaseCatalogMutation(s)`, and `BundleRepository` are gone.
  - **`createHotUpdater`:** takes `{ database, storage?, plugins?, clientAccess? }`; `plugins` defaults to none. `clientAccess` is `"public"`, or absent when a plugin provides clientAuth. A `clientAccess` object is a type error whose message names `apiKeys()`, and at startup a `HotUpdaterConfigError` that names it too. The instance is `{ handlers, core, api, adapterName }`: bundle, channel, release, Insights, and API key methods on it are gone; use `core` and the plugins' `api`. `registerApiKey`, `createApiKey`, `provisionApiKey`, and `createHandlers` are no longer exported; the `apiKeys()` plugin's API does the same work.
  - **Handlers:** client routes read catalogs and artifacts through core. The admin API speaks protocol 2 only: `v=2` is accepted and changes nothing, and `POST /database/commit`, `POST /bundles`, and `DELETE /bundles/:id` are gone (deploy with `POST /releases`, delete with `POST /bundles/delete`). `PATCH /bundles/:id` answers 204. The Insights routes come from `insights()`; without it they answer 204 with `x-hot-updater-insights: disabled`.
  - **Schema:** generated SQL, Drizzle, and Prisma schemas have no database foreign keys; the engine keeps references. CockroachDB and SQL Server are no longer supported, and `relationMode` is gone. The checked-in Postgres and Supabase SQL is regenerated.
  - **Providers:** `postgres`, `d1Database`, `supabaseDatabase`, `firebaseDatabase`, and `dynamoDB` return engine databases. `dynamoDB` invalidates the cached update-check routes after a write that changes a Release Catalog.
  - **`standaloneRepository`:** is `{ name, core, fetchAdmin }` over admin API protocol 2; its protocol 1 reads and custom bundle `routes` are gone.
  - **`@hot-updater/test-utils`:** `setupDatabaseTestSuite` runs core, bundles, the Release Catalog contract, and Insights through admin API protocol 2 over HTTP, and with `createInsightsModel` the Insights report contract. It replaces `setupDatabasePluginTestSuite` and `setupDatabaseClientTestSuite`. `setupBundleMethodsTestSuite` and `setupReleaseCatalogTestSuite` take `{ getClient }` on protocol 2.
  - **CLI and console:** they read and write through core only. `hot-updater api-key` manages keys through the config's `apiKeys()` plugin, and the console runs the config's `plugins`: without them, Insights and API keys are off.

### Patch Changes

- d482b13: The agent setup checklists that `hot-updater agent infra` writes describe a 1.0 release candidate's resources the way the upgrade notes do. The Supabase checklist no longer points to a removed commit RPC migration: release candidate tables and functions are dropped and their migrations marked reverted before the push. The Cloudflare checklist treats a D1 database that recorded `0001_hot-updater_1.0.0.sql` without `schema.engine` as incompatible, and the AWS checklist's DynamoDB leading keys match the policy the scaffold writes.
- d482b13: Auto-patch bases match what `deploy` chose before the storage engine. `core.findBaseBundleIds` reads the new bundle's Release Catalog scope in one point read and keeps every enabled bundle release whose target app version range intersects the new target (the same fingerprint, in a fingerprint scope), newest release first, each bundle once and older than the new bundle, up to `patch.maxBaseBundles`. Targets such as `1.x`, `*`, or `>=1.2.0 <2` get bases again, a `*` or `1.x` release serves every version it covers, a release on another patch version of the same minor line no longer takes a slot, and a promoted or republished bundle counts from its newest release.

  `targetBaseCandidateKey` takes the channel name instead of its id, and its key names the catalog scope and the normalized range. The `base_candidates` aggregate and its gauge writes are gone, so each release change writes up to 16 fewer rows; the checked-in D1, Postgres, and Supabase schemas drop the table.

- 94b56f3: Run DynamoDB on the new storage engine. `dynamoDB(config)` keeps its signature, and still invalidates the update-check routes' CloudFront copies after a write that changes what they answer.
  - **One table, no secondary index:** the plugin is the key-value helper over one table keyed by string `pk` and `sk`. Each row is an item. Each index a row belongs to adds an item holding a copy of it, written in the same transaction. Reads are strongly consistent, and a write is one `TransactWriteItems` with a client request token. Commits over 100 items, 4 MB, or 400 KB in one item are refused before anything is written.
  - **Schema settings:** the plugin checks the schema settings before its first read and answers 503 until they exist. `migrateDynamoDB(config)` writes them, and creates the table when it is missing. `hot-updater init` runs it after creating the table, the agent scaffold ships the same items as `dynamodb/schema-settings.json`, and the DynamoDB example runs it before registering its API key.
  - **Infrastructure:** `hot-updater init` creates the table without `hot-updater-update-index` and refuses a table that still has it, which a 1.0 release candidate created. The IAM policy allows the key-value store's reads and writes on each table's partitions, `<table>` and `<table>#*`.
  - **Insights shards:** gauge aggregates (`insights_distribution`, `insights_latest_by_bundle`) now spread over 32 shards, on every backend. DynamoDB's contention gate, on DynamoDB Local with 16 writers at 100 moves per second, retried 2–24% of rollout moves at 16 and 1–5% at 32; these are test figures, not production limits. Sketches stay at 16, since every read merges their 2 KB registers, and counters stay at 8. Rows already written on shards 0–15 keep counting.
  - **Removed:** the DynamoDB implementation (about 4,200 lines) and `DYNAMODB_UPDATE_INDEX_NAME`.

- ad00722: Provision API keys through the `apiKeys()` plugin, and let core republish a stored bundle.
  - **`core.deploy`:** a deployment may name a bundle the database already holds, as `{ bundleId, release }`. It publishes a new release for that bundle in the release's scope and writes no bundle. A missing bundle refuses with `DatabaseBundleNotFoundError`. `Deployment` is now `BundleDeployment | StoredBundleDeployment`, and admin API protocol 2's `POST /releases` accepts both.
  - **`createDatabasePluginApis`:** it is typed by its plugin list, so `createDatabasePluginApis(database, plugins).apiKeys.provision(...)` needs no cast.
  - **API key provisioning:** `hot-updater init` for AWS, Cloudflare, Firebase, and Supabase registers the app's client key through the provider's `plugins` (the `apiKeys()` plugin its managed server runs) instead of the database plugin's `models.apiKeys`. The agent scaffold's `provision-api-key.mjs` uses the scaffold's `hotUpdater.plugins.ts` the same way.

- d7df92c: Run Firestore on the new storage engine. `firebaseDatabase(config)` keeps its signature and gains an optional `collection`.
  - **One collection:** every item is a `{ pk, sk, row }` document in `hot_updater_v1`, with a hashed document id. Each index a row belongs to adds a document holding a copy of it, written in the same transaction. Reads use two composite indexes, `pk` with `sk` ascending and descending, and `row` is exempt from single-field indexing. `firestore.indexes.json` is generated from the schema and holds just those.
  - **Transactions:** a write is one `runTransaction` that reads only the documents its ops guard. Counters increment without a read, so they hold no read lock: `update` needs the document, so a write whose counter row is missing reruns, reads it, and creates it from `init`. Maps and arrays are stored as JSON text, since Firestore has no nested arrays and does not keep map key order.
  - **Schema settings:** the plugin checks the schema settings before its first read and answers 503 until they exist. `migrateFirebaseDatabase(config)` writes them. `hot-updater init` runs it after deploying the indexes, and the agent scaffold's key script runs it through `api-key.config.ts`'s new `migrate` export. Init refuses a project whose `hot_updater_v1_*` collections hold data from a 1.0 release candidate.
  - **Init:** merging the project's index overrides with ours now replaces an override for the same field instead of merging the lists by position.
  - **Key lengths:** the key-value helper refuses a write whose partition or sort key is longer than the store indexes whole (DynamoDB 2,048 and 1,024 bytes, Firestore 1,500), as `too_large`, instead of failing in the store or truncating the index.
  - **Removed:** the Firestore implementation (about 2,100 lines), the adapter version marker, and the channel-id registry documents.

- d482b13: The 1.0.0 infrastructure upgrade notes that `hot-updater infra scaffold` writes no longer ask a release candidate deployment to apply schema additions in place, or to look for tables and columns that the storage engine replaced. A release candidate's database is recreated: a D1 database that recorded `0001_hot-updater_1.0.0.sql` gets a new database or dropped tables before the scaffold's migrations, and the Worker waits for `schema.engine`.
- e542054: Run the Kysely adapter and the `postgres` plugin on the new storage engine. Their factory signatures are unchanged.
  - **Kysely:** `kyselyAdapter` runs PostgreSQL, MySQL, and SQLite through the shared SQL core with `kyselyExecutor`.
    - Its migrator applies the generated SQL schema: tables, indexes, and the settings rows, written last.
    - The migrator refuses a v0 or pre-engine database instead of converting it.
  - **Schema fence:** both adapters fence their schema. A database without the `schema.engine` row is refused before its first read, and handlers answer 503.
  - **`postgres` plugin:** `sql/bundles.sql` is now the generated SQL schema, and a test fails when the two differ.
  - **Removed:** the plugin-specific Insights helpers `getKyselyAppUsage`, `getKyselyReleaseActivity`, `readKyselyInsightsHead`, and `recordKyselyInsightsOverview` are no longer exported from `@hot-updater/server`.
  - **Upgrade note:** the 1.0.0 infrastructure upgrade note now says that RC databases created before the adapter redesign must be recreated.

- 3f30a23: Serve Insights and API keys through plugins.
  - **Insights routes:** `POST /events` and the admin Insights reads come from the `insights()` plugin. Without it, each answers 204 with `x-hot-updater-insights: disabled`.
  - **API keys:** the `apiKeys()` plugin protects client routes with the same header the `clientAccess: { type: "api-key" }` option used, so a server that moves to plugins never falls back to public.
  - **Core reads:** `hotUpdater.core` reads bundles, Releases, Catalogs, and channels. Plugins get the same reads as `ctx.core`, on the same engine. A plugin cannot take the id `core`.
  - **Plugin APIs:** `hotUpdater.api.insights` and `hotUpdater.api.apiKeys` replace `hotUpdater.insights` and `hotUpdater.apiKeys`.
  - **Providers:** `@hot-updater/aws`, `cloudflare`, `firebase`, and `supabase` export `plugins`, their managed server's plugin list (`insights()` and `apiKeys()`). The Lambda, Worker, Cloud Function, and Edge Function templates use it, with the same `x-api-key` header.
  - **CLI:** `generate-standalone-sql` and the missing-export help text use the new options.

- Updated dependencies [152db48]
- Updated dependencies [23a972d]
- Updated dependencies [d482b13]
- Updated dependencies [802374f]
- Updated dependencies [d482b13]
- Updated dependencies [d482b13]
- Updated dependencies [d482b13]
- Updated dependencies [fe03f59]
- Updated dependencies [8d60f68]
- Updated dependencies [d482b13]
- Updated dependencies [d482b13]
- Updated dependencies [d482b13]
- Updated dependencies [23a972d]
- Updated dependencies [294c53f]
- Updated dependencies [d482b13]
- Updated dependencies [94470aa]
- Updated dependencies [2431c0a]
- Updated dependencies [7758a1e]
- Updated dependencies [7ba867c]
- Updated dependencies [94b56f3]
- Updated dependencies [d482b13]
- Updated dependencies [b3576f2]
- Updated dependencies [af15ef3]
- Updated dependencies [aee193e]
- Updated dependencies [0f670c5]
- Updated dependencies [d482b13]
- Updated dependencies [ad00722]
- Updated dependencies [d7df92c]
- Updated dependencies [d482b13]
- Updated dependencies [d482b13]
- Updated dependencies [d482b13]
- Updated dependencies [d482b13]
- Updated dependencies [d3a5570]
- Updated dependencies [d482b13]
- Updated dependencies [d3a5570]
- Updated dependencies [f6ffb68]
- Updated dependencies [d482b13]
- Updated dependencies [c68e9f3]
- Updated dependencies [d482b13]
- Updated dependencies [e542054]
- Updated dependencies [73b8920]
- Updated dependencies [065c457]
- Updated dependencies [8a03eb2]
- Updated dependencies [ff1e565]
- Updated dependencies [d482b13]
- Updated dependencies [aee193e]
- Updated dependencies [152db48]
- Updated dependencies [228b6c7]
- Updated dependencies [eef9466]
- Updated dependencies [065c457]
- Updated dependencies [3f30a23]
- Updated dependencies [065c457]
- Updated dependencies [754a73e]
- Updated dependencies [d482b13]
- Updated dependencies [df31037]
- Updated dependencies [a6c00ec]
  - @hot-updater/server@1.0.0-rc.16
  - @hot-updater/aws@1.0.0-rc.16
  - @hot-updater/cloudflare@1.0.0-rc.16
  - @hot-updater/supabase@1.0.0-rc.16
  - @hot-updater/plugin-core@1.0.0-rc.16
  - @hot-updater/console@1.0.0-rc.18
  - @hot-updater/cli-tools@1.0.0-rc.16
  - @hot-updater/firebase@1.0.0-rc.16
  - @hot-updater/android-helper@1.0.0-rc.16
  - @hot-updater/apple-helper@1.0.0-rc.16

## 1.0.0-rc.17

### Minor Changes

- f5fffea: Add atomic Release Insights aggregates, direct release-health and app-usage
  queries, and the redesigned Insights console without reconstructing metrics from
  raw event history.
- 88add06: Add deterministic doctor scopes for configured infrastructure scaffolds and live server verification. Agents can gate completion on structured checks and exit codes instead of deployment records. Reuse the server protocol probe in doctor and the packaged helper, and document which checks remain outside each scope.

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

- 39f60f9: Serialize Kysely database commits and retry native serialization conflicts so concurrent Release revision and Catalog generation expectations cannot both succeed with the same version.

  Replace Firebase row fields atomically instead of recursively merging JSON metadata, while preserving unrelated document extension fields.

  Apply Supabase migration `20260922000000_idempotent_channel_commit.sql` to existing generation 1 projects. It makes generic deletion of a missing Channel an atomic no-op, preserving table layouts, schema version, existing data, and RPC permissions.

- Updated dependencies [f5fffea]
- Updated dependencies [79c3eea]
- Updated dependencies [d99530b]
- Updated dependencies [79c3eea]
- Updated dependencies [39f60f9]
  - @hot-updater/aws@1.0.0-rc.15
  - @hot-updater/cloudflare@1.0.0-rc.15
  - @hot-updater/console@1.0.0-rc.17
  - @hot-updater/firebase@1.0.0-rc.15
  - @hot-updater/plugin-core@1.0.0-rc.15
  - @hot-updater/server@1.0.0-rc.15
  - @hot-updater/supabase@1.0.0-rc.15
  - @hot-updater/cli-tools@1.0.0-rc.15
  - @hot-updater/core@1.0.0-rc.15
  - @hot-updater/android-helper@1.0.0-rc.15
  - @hot-updater/apple-helper@1.0.0-rc.15

## 1.0.0-rc.16

### Patch Changes

- 03d4369: Read the default iOS target app version from `project.pbxproj` when `Info.plist` holds an unresolved build setting. The React Native template ships `CFBundleShortVersionString` as `$(MARKETING_VERSION)`, which the plist parser cannot resolve, so `getDefaultTargetAppVersion` returned `null` for most iOS projects: `deploy -i` prefilled the "Target app version" prompt with `1.0.0` instead of the real version, and non-interactive `deploy` without `-t` failed outright. `getNativeAppVersion` already falls back to the same parser; this aligns the two.
- Updated dependencies [3fa24fc]
  - @hot-updater/console@1.0.0-rc.16

## 1.0.0-rc.15

### Patch Changes

- Updated dependencies [7f3ba17]
  - @hot-updater/console@1.0.0-rc.15

## 1.0.0-rc.14

### Patch Changes

- Align all Hot Updater packages on 1.0.0-rc.14 for a coordinated release candidate. Future releases continue to use independent package versions.
- b23db5e: Replace shared Insights installation storage with canonical events and provider-private indexes for current installation queries. SQL and MongoDB keep nine access fields and fetch full event payloads only for selected results; DynamoDB counts compact scope entries. Custom providers implement `recordEvent({ event })`, `findLatestEvents`, and explicit `countLatestEvents` predicates without lifecycle helpers. Move ancillary event fields into typed `metadata`, reusing Bundle JSON conventions, while preserving SDK requests and Console responses.

  This changes the unreleased 1.0.0 initialization and custom database contract from the previous installation-row design. The read-cost fix preserves the canonical-event contract and keeps current-state queries independent of retained event history. Append and index updates are atomic; measured read/write costs are documented.

- b23db5e: Align Firebase Functions and its CLI with the Admin SDK used by generated servers. Firebase emulator checks now require Java 21.

  Forward the original JSON request body through the Firebase Functions entrypoint so Insights events retain their payload and can be recorded.

  Allow the managed AWS runtime to access release catalogs and release lookup records required by the current storage implementation.

- e828ecb: Finish agent infrastructure setup with a ready-to-copy HotUpdater.init snippet
  containing the verified server URL and registered client API key.
- Updated dependencies [479c1e5]
- Updated dependencies
- Updated dependencies [b23db5e]
- Updated dependencies [b23db5e]
- Updated dependencies [b0387d8]
  - @hot-updater/server@1.0.0-rc.14
  - @hot-updater/console@1.0.0-rc.14
  - @hot-updater/plugin-core@1.0.0-rc.14
  - @hot-updater/cloudflare@1.0.0-rc.14
  - @hot-updater/supabase@1.0.0-rc.14
  - @hot-updater/firebase@1.0.0-rc.14
  - @hot-updater/aws@1.0.0-rc.14
  - @hot-updater/android-helper@1.0.0-rc.14
  - @hot-updater/apple-helper@1.0.0-rc.14
  - @hot-updater/cli-tools@1.0.0-rc.14
  - @hot-updater/core@1.0.0-rc.14

## 1.0.0-rc.13

### Patch Changes

- Updated dependencies [1e42b0b]
  - @hot-updater/console@1.0.0-rc.11

## 1.0.0-rc.12

### Patch Changes

- Updated dependencies [21520c7]
  - @hot-updater/console@1.0.0-rc.10

## 1.0.0-rc.11

### Patch Changes

- Updated dependencies [3385448]
  - @hot-updater/console@1.0.0-rc.9

## 1.0.0-rc.10

### Patch Changes

- Updated dependencies [6108b6d]
- Updated dependencies [f9686ed]
  - @hot-updater/console@1.0.0-rc.8

## 1.0.0-rc.9

### Patch Changes

- 2cb3cf0: Make agent infrastructure onboarding resumable through provider checklists with explicit prerequisites, verification evidence and pending-operation records. Package a read-only server verification helper, align database/key/deployment ordering with init, and export AWS DynamoDB/IAM request templates from the same builders used by interactive setup.
- 610054e: Report the configured console port when it is already in use and exit before starting another server.
- Updated dependencies [24653fd]
- Updated dependencies [8a331bf]
- Updated dependencies [2cb3cf0]
  - @hot-updater/console@1.0.0-rc.7
  - @hot-updater/aws@1.0.0-rc.4

## 1.0.0-rc.8

### Patch Changes

- Updated dependencies [f869358]
- Updated dependencies [663d8e9]
- Updated dependencies [663d8e9]
  - @hot-updater/supabase@1.0.0-rc.4
  - @hot-updater/console@1.0.0-rc.6
  - @hot-updater/server@1.0.0-rc.3
  - @hot-updater/plugin-core@1.0.0-rc.3
  - @hot-updater/cloudflare@1.0.0-rc.5
  - @hot-updater/aws@1.0.0-rc.3
  - @hot-updater/firebase@1.0.0-rc.4
  - @hot-updater/android-helper@1.0.0-rc.3
  - @hot-updater/apple-helper@1.0.0-rc.3
  - @hot-updater/cli-tools@1.0.0-rc.3

## 1.0.0-rc.7

### Minor Changes

- ed17bef: Add `hot-updater infra scaffold --provider <provider>` for standalone server
  template extraction without an agent or app build selection. Reuse its extractor
  in `hot-updater agent infra setup` and `hot-updater agent infra upgrade` to
  generate versioned deployment templates and agent instructions for Cloudflare,
  Supabase, AWS, and Firebase. Scaffolds preserve existing edits and provide
  provider-specific verification, resume guidance, and private reusable API-key
  provisioning. Agents apply the files through their available provider tools.

  Connect doctor remediation to the agent commands and require a complete
  version-named Markdown release file for every infrastructure requirement.
  Retain historical files and provide an ordered index so agents can read the
  complete upgrade path, including intermediate releases. Include the
  v0-to-v1 coexistence and native-build transition as the initial upgrade record.
  Share existing provider config builders with the packaged scaffolds.

  Include provider environment guides explaining each variable's purpose,
  conditions and secure source. Guide agents to discover the app and existing
  resources, create missing infrastructure, and ask only for unresolved choices
  or access, without requesting secrets in chat.

  Accept the bundled server prerelease in doctor when running the matching
  prerelease CLI, while retaining generation checks and stable release requirements.
  Check helper runtime prerequisites before provisioning, apply Cloudflare config
  before migrations, and include Firebase download-signing permissions and reusable
  application-default credentials in the onboarding instructions.

### Patch Changes

- Updated dependencies [ed17bef]
- Updated dependencies [5c8972c]
- Updated dependencies [c3f7896]
  - @hot-updater/cloudflare@1.0.0-rc.4
  - @hot-updater/supabase@1.0.0-rc.3
  - @hot-updater/firebase@1.0.0-rc.3
  - @hot-updater/console@1.0.0-rc.5

## 1.0.0-rc.6

### Patch Changes

- Updated dependencies [8afd7a8]
  - @hot-updater/console@1.0.0-rc.4

## 1.0.0-rc.5

### Patch Changes

- 47caf8a: Validate signing only for the selected deploy platform.

## 1.0.0-rc.4

### Patch Changes

- Updated dependencies [1067058]
  - @hot-updater/console@1.0.0-rc.3

## 1.0.0-rc.3

### Patch Changes

- 8c3c4f2: Report the default `production` channel in `hot-updater channel` when the native files carry no channel value, instead of showing an empty channel.
- 6ccceec: Exit with code 1 when `hot-updater doctor` fails with an error such as a missing `package.json` or an uninstalled CLI. The default output previously printed "Doctor check failed." and exited 0, so CI treated a failed doctor run as a pass, while `--json` already exited 1 for the same result.
- a837c71: Upgrade verkit to 0.4.0 while preserving canonical app-version strings and
  Doctor's package-version compatibility checks with the new parsed SemVer
  return values. Upgrade the workspace build tool tsdown to 0.22.14.
- f48521a: Align the console ID, `HotUpdater.getBundleId()`, update-check results, completion callbacks, and `bundle list/show` with the selected update identity so promotions sharing an artifact remain distinguishable. The getter can reflect a staged update before reload. Remove the prerelease `getReleaseId()` getter, keep artifact and crash identities unchanged, and move Artifact IDs into Advanced diagnostics. `bundle list --json` returns the internal rows, and `bundle show` accepts the console ID. Use `HotUpdater.getManifest().bundleId` for BugSnag sourcemap matching.
- 0546348: Keep the v0 bundle mental model while using the console update ID everywhere. Deploy now prints that ID once in its final success area, and `bundle list`, `show`, `update`, `preflight`, `enable`, `disable`, `delete`, and `promote` all accept the same ID. The prerelease `release` command is removed. Immutable-file cleanup moves to Advanced `bundle artifact delete <artifact-id>`, and patch creation uses `--artifact-id` and `--base-artifact-id` (with the old bundle-named flags retained as hidden aliases). Raw JSON and internal database fields remain unchanged.
- Updated dependencies [e6d9ae7]
- Updated dependencies [51300d4]
- Updated dependencies [483483e]
- Updated dependencies [590ca70]
- Updated dependencies [a837c71]
- Updated dependencies [f48521a]
  - @hot-updater/console@1.0.0-rc.2
  - @hot-updater/server@1.0.0-rc.2
  - @hot-updater/plugin-core@1.0.0-rc.2
  - @hot-updater/aws@1.0.0-rc.2
  - @hot-updater/cloudflare@1.0.0-rc.3
  - @hot-updater/firebase@1.0.0-rc.2
  - @hot-updater/supabase@1.0.0-rc.2
  - @hot-updater/cli-tools@1.0.0-rc.2
  - @hot-updater/android-helper@1.0.0-rc.2
  - @hot-updater/apple-helper@1.0.0-rc.2

## 1.0.0-rc.2

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
  - @hot-updater/server@1.0.0-rc.1
  - @hot-updater/console@1.0.0-rc.1
  - @hot-updater/cli-tools@1.0.0-rc.1
  - @hot-updater/aws@1.0.0-rc.1
  - @hot-updater/cloudflare@1.0.0-rc.2
  - @hot-updater/firebase@1.0.0-rc.1
  - @hot-updater/supabase@1.0.0-rc.1
  - @hot-updater/android-helper@1.0.0-rc.1
  - @hot-updater/apple-helper@1.0.0-rc.1

## 1.0.0-rc.1

### Patch Changes

- 2aeccfb: Allow Doctor to accept package increments within the same prerelease channel.

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

- 88c163a: Align the CLI with the Release Catalog ownership model. Deploy now reports the
  committed Release and Catalog handles, Release commands expose and preview
  policy state, Bundle commands report Release references, missing Catalog
  projections can be rebuilt, and storage pruning safely reclaims unreferenced
  patch objects below live Bundle prefixes.

  Remove the ambiguous top-level Bundle-targeted rollback command. Use
  `hot-updater release disable <release-id>` to roll back an exact Release.

- a9ffb2a: Require R2 S3 credentials, drop Wrangler `r2Storage` and Android `stringResourcePaths`. Doctor only targets infrastructure generation 1.0.0. Channel, fingerprint, and signing keys live in AndroidManifest.xml.
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

- a9ffb2a: Create schema 1.0.0 from empty databases only. `db migrate` and `db generate` no longer accept or upgrade v0 schema markers, and managed SQL templates are a single 1.0.0 CREATE.

### Patch Changes

- 353e1ca: Package the full Console application behind root and `/vite` exports so a thin
  Vite and Nitro host can deploy it with injected runtime configuration and
  authentication. Keep the CLI console unauthenticated but force it to bind to
  the loopback interface.
- c387b0b: Allow independently released Hot Updater packages from the same stable major
  version to pass doctor compatibility checks.
- c06c7df: Restore the plain `#!/usr/bin/env node` shebang on the CLI entry so Yarn Classic generates a working `hot-updater.cmd` shim on Windows.
- c06c7df: Rename the CLI's `init --env-file` option to `init --from-env-file` to avoid Node.js interpreting replay files as its own startup configuration. This keeps the portable shebang required by Yarn Classic on Windows without allowing `NODE_OPTIONS` in a replay file to run preloads before the CLI starts.

  Breaking change: update replay commands to `hot-updater init --from-env-file .env.hotupdater`. The old `--env-file` CLI option is no longer supported. The programmatic `envFile` option is unchanged.

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

- 3b367e7: Split the self-hosted HTTP runtime into mount-relative
  `handlers.client` and `handlers.admin` surfaces. Admin authentication now
  belongs entirely to framework middleware, mounting the admin handler is the
  explicit opt-in, and admin responses are marked private and non-cacheable.

  Move the canonical admin root from `/hot-updater/api` to
  `/hot-updater/admin`. `standaloneRepository.baseUrl` now points directly to
  that root and sends mount-relative Bundle, Release, Release Catalog, Channel,
  and database-commit requests. Managed runtimes mount only the client handler.

  Remove `features`, including `features.bundles`, `features.updateCheck`, and
  `features.clientAccessKeys`, plus Analytics `queryAccess`. The required
  top-level `clientAccess` policy now selects public or API-key authenticated
  client routes. The client handler always owns update routes and Analytics
  ingestion, while Analytics queries move to the admin surface. React Native
  clients independently opt into automatic transition reporting.
  `toNodeHandler` now accepts one handler function. React Native keeps the same
  client `baseURL` and resolves handler-relative storage paths against it,
  removing the server's `basePath` option. Client authentication uses `x-api-key`,
  not an admin bearer token.

  Resolve Expo fingerprint mode from the target app's dependencies so bare React
  Native fingerprints stay stable across monorepo and isolated installs.

- Updated dependencies [3b367e7]
- Updated dependencies [467e5f6]
- Updated dependencies [353e1ca]
- Updated dependencies [b424d47]
- Updated dependencies [3b367e7]
- Updated dependencies [9650748]
- Updated dependencies [88c163a]
- Updated dependencies [a9ffb2a]
- Updated dependencies [a9ffb2a]
- Updated dependencies [5a2e1cd]
- Updated dependencies [adb0e40]
- Updated dependencies [e2455c5]
- Updated dependencies [ebe1f64]
- Updated dependencies [c8e24cd]
- Updated dependencies [25af6ef]
- Updated dependencies [c06c7df]
- Updated dependencies [c355c26]
- Updated dependencies [e494531]
- Updated dependencies [3b367e7]
- Updated dependencies [7ec1a46]
- Updated dependencies [1af8cba]
- Updated dependencies [3b367e7]
- Updated dependencies [86f610b]
- Updated dependencies [a9ffb2a]
- Updated dependencies [a9ffb2a]
  - @hot-updater/plugin-core@1.0.0-rc.0
  - @hot-updater/server@1.0.0-rc.0
  - @hot-updater/console@1.0.0-rc.0
  - @hot-updater/cli-tools@1.0.0-rc.0
  - @hot-updater/aws@1.0.0-rc.0
  - @hot-updater/cloudflare@1.0.0-rc.0
  - @hot-updater/firebase@1.0.0-rc.0
  - @hot-updater/supabase@1.0.0-rc.0
  - @hot-updater/core@1.0.0-rc.0
  - @hot-updater/android-helper@1.0.0-rc.0
  - @hot-updater/apple-helper@1.0.0-rc.0

## 0.36.0

### Minor Changes

- 9759e8a: Reduce S3 management query work by skipping legacy UUIDv7 artifact traversal, deriving channels from canonical manifest keys, and batching multi-bundle deletion scans and commits. Store new bundle artifacts below `bundles/<bundle-id>` while preserving legacy reads, and add exact target app version filters to the CLI and Console. Add an exclusive-maintenance `hot-updater storage prune` command for orphaned bundle objects and unreferenced shared assets, with an explicit `--dry-run` candidate table, a recent-object protection window, and fail-closed reference validation safeguards.

### Patch Changes

- da7de2d: Preserve UUIDv7 S3 channels while avoiding per-prefix legacy traversal, respect
  standalone server pagination limits during storage pruning and batch deletion,
  and document the safe storage cleanup workflow.
- Updated dependencies [9759e8a]
  - @hot-updater/cli-tools@0.36.0
  - @hot-updater/plugin-core@0.36.0
  - @hot-updater/console@0.36.0
  - @hot-updater/server@0.36.0
  - @hot-updater/android-helper@0.36.0
  - @hot-updater/apple-helper@0.36.0
  - @hot-updater/core@0.36.0

## 0.35.12

### Patch Changes

- 6e8b32e: Replace the semver dependency with verkit.
- Updated dependencies [fd30452]
- Updated dependencies [6e8b32e]
  - @hot-updater/cli-tools@0.35.12
  - @hot-updater/console@0.35.12
  - @hot-updater/plugin-core@0.35.12
  - @hot-updater/server@0.35.12
  - @hot-updater/android-helper@0.35.12
  - @hot-updater/apple-helper@0.35.12
  - @hot-updater/core@0.35.12

## 0.35.11

### Patch Changes

- bfbb823: fix: read the iOS app version from Info.plist before project.pbxproj

  `getNativeAppVersion("ios")` tried the `xcodeproj` parser first and only fell back
  to `info-plist`. Parsing project.pbxproj is synchronous, so on a large project it
  blocks the event loop for the whole parse, and `deploy` does this after the bundle
  has already been uploaded, just to fill in `metadata.app_version`. On a 12.5MB
  pbxproj that was ~5 minutes locally and ~16 minutes on CI.

  Info.plist is read first now. `CFBundleShortVersionString` is also closer to what
  the built app actually reports than `MARKETING_VERSION` (#84). The xcodeproj parser
  is still there as a fallback when Info.plist has no version.

- bfbb823: fix: bump the bundled `@bacons/xcode` to 1.0.0-alpha.33

  alpha.24 was published in December 2024 and still uses the old Chevrotain-based
  pbxproj parser. alpha.31 picked up the single-pass rewrite from
  EvanBacon/xcode#37, which is 42x faster on their benchmarks and considerably more
  than that on large files.

  On a 12.5MB `project.pbxproj`, `XcodeProject.open()` goes from 286s and 1.8GB of
  peak RSS down to 0.2s and 285MB, returning the same 48,670 objects. The only API
  used here is `XcodeProject.open().toJSON()` in `getIOSVersion`, which is unchanged
  between the two versions.

- fceb580: fix: fallback to project.pbxproj when Info.plist contains an unresolved build setting
- Updated dependencies [1a3a621]
  - @hot-updater/plugin-core@0.35.11
  - @hot-updater/android-helper@0.35.11
  - @hot-updater/apple-helper@0.35.11
  - @hot-updater/cli-tools@0.35.11
  - @hot-updater/console@0.35.11
  - @hot-updater/server@0.35.11
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
  - @hot-updater/cli-tools@0.35.10
  - @hot-updater/android-helper@0.35.10
  - @hot-updater/apple-helper@0.35.10
  - @hot-updater/console@0.35.10
  - @hot-updater/server@0.35.10
  - @hot-updater/core@0.35.10

## 0.35.9

### Patch Changes

- f9bb26d: Declare init inputs in each provider package through a shared contract, ask
  once before saving credential inputs, and support prompt-free infrastructure
  reconciliation with `init --env-file .env.hotupdater`.
- Updated dependencies [8688b1a]
- Updated dependencies [f9bb26d]
  - @hot-updater/cli-tools@0.35.9
  - @hot-updater/android-helper@0.35.9
  - @hot-updater/apple-helper@0.35.9
  - @hot-updater/console@0.35.9
  - @hot-updater/core@0.35.9
  - @hot-updater/server@0.35.9
  - @hot-updater/plugin-core@0.35.9

## 0.35.8

### Patch Changes

- Updated dependencies [4f9fab2]
  - @hot-updater/cli-tools@0.35.8
  - @hot-updater/android-helper@0.35.8
  - @hot-updater/apple-helper@0.35.8
  - @hot-updater/console@0.35.8
  - @hot-updater/core@0.35.8
  - @hot-updater/server@0.35.8
  - @hot-updater/plugin-core@0.35.8

## 0.35.7

### Patch Changes

- @hot-updater/android-helper@0.35.7
- @hot-updater/apple-helper@0.35.7
- @hot-updater/cli-tools@0.35.7
- @hot-updater/console@0.35.7
- @hot-updater/core@0.35.7
- @hot-updater/server@0.35.7
- @hot-updater/plugin-core@0.35.7

## 0.35.6

### Patch Changes

- @hot-updater/android-helper@0.35.6
- @hot-updater/apple-helper@0.35.6
- @hot-updater/cli-tools@0.35.6
- @hot-updater/console@0.35.6
- @hot-updater/core@0.35.6
- @hot-updater/server@0.35.6
- @hot-updater/plugin-core@0.35.6

## 0.35.5

### Patch Changes

- @hot-updater/android-helper@0.35.5
- @hot-updater/apple-helper@0.35.5
- @hot-updater/cli-tools@0.35.5
- @hot-updater/console@0.35.5
- @hot-updater/core@0.35.5
- @hot-updater/server@0.35.5
- @hot-updater/plugin-core@0.35.5

## 0.35.4

### Patch Changes

- @hot-updater/android-helper@0.35.4
- @hot-updater/apple-helper@0.35.4
- @hot-updater/cli-tools@0.35.4
- @hot-updater/console@0.35.4
- @hot-updater/core@0.35.4
- @hot-updater/server@0.35.4
- @hot-updater/plugin-core@0.35.4

## 0.35.3

### Patch Changes

- @hot-updater/android-helper@0.35.3
- @hot-updater/apple-helper@0.35.3
- @hot-updater/cli-tools@0.35.3
- @hot-updater/console@0.35.3
- @hot-updater/core@0.35.3
- @hot-updater/server@0.35.3
- @hot-updater/plugin-core@0.35.3

## 0.35.2

### Patch Changes

- e3f0962: Add bulk deletion to `hot-updater bundle delete`. The command now accepts multiple bundle ids (`bundle delete <id...>`)
  - @hot-updater/android-helper@0.35.2
  - @hot-updater/apple-helper@0.35.2
  - @hot-updater/cli-tools@0.35.2
  - @hot-updater/console@0.35.2
  - @hot-updater/core@0.35.2
  - @hot-updater/server@0.35.2
  - @hot-updater/plugin-core@0.35.2

## 0.35.1

### Patch Changes

- @hot-updater/android-helper@0.35.1
- @hot-updater/apple-helper@0.35.1
- @hot-updater/cli-tools@0.35.1
- @hot-updater/console@0.35.1
- @hot-updater/core@0.35.1
- @hot-updater/server@0.35.1
- @hot-updater/plugin-core@0.35.1

## 0.35.0

### Minor Changes

- 4e1b86d: Make the `@hot-updater/server` root export runtime-safe, remove the ambiguous `@hot-updater/server/runtime` subpath, keep `@hot-updater/server/node` focused on `toNodeHandler`, and move database generation, migration, and bundle diff APIs to `@hot-updater/server/db`.

### Patch Changes

- Updated dependencies [4e1b86d]
  - @hot-updater/server@0.35.0
  - @hot-updater/console@0.35.0
  - @hot-updater/android-helper@0.35.0
  - @hot-updater/apple-helper@0.35.0
  - @hot-updater/cli-tools@0.35.0
  - @hot-updater/core@0.35.0
  - @hot-updater/plugin-core@0.35.0

## 0.34.0

### Minor Changes

- 8a4a269: feat(hot-updater): add `--provider` and `--build` flags to `init`

  `hot-updater init` always prompts for the build plugin and the provider. These optional flags pre-answer those two prompts so `init` can run without interaction:

  ```
  hot-updater init --provider cloudflare --build expo
  ```

  When a flag is omitted, the prompt is shown as before. Values are validated against the known choices.

  This is aimed at the Cloudflare redeploy flow described in #849: with a populated `.env.hotupdater`, re-running `init` redeploys the worker and applies pending migrations, and these flags remove the two prompts that otherwise block it from running unattended. Providers still prompt for any value that is not already present in `.env.hotupdater`.

### Patch Changes

- 088f6c1: refactor(server): remove fumadb adapter split
- 7244b65: Fix standalone database generation for provider SQL output and generated schema regeneration, and centralize the generated DB schema artifact contract.
- Updated dependencies [088f6c1]
- Updated dependencies [7244b65]
  - @hot-updater/server@0.34.0
  - @hot-updater/plugin-core@0.34.0
  - @hot-updater/core@0.34.0
  - @hot-updater/console@0.34.0
  - @hot-updater/android-helper@0.34.0
  - @hot-updater/apple-helper@0.34.0
  - @hot-updater/cli-tools@0.34.0

## 0.33.2

### Patch Changes

- @hot-updater/android-helper@0.33.2
- @hot-updater/apple-helper@0.33.2
- @hot-updater/cli-tools@0.33.2
- @hot-updater/console@0.33.2
- @hot-updater/core@0.33.2
- @hot-updater/server@0.33.2
- @hot-updater/plugin-core@0.33.2

## 0.33.1

### Patch Changes

- Updated dependencies [a5c4467]
  - @hot-updater/console@0.33.1
  - @hot-updater/plugin-core@0.33.1
  - @hot-updater/server@0.33.1
  - @hot-updater/android-helper@0.33.1
  - @hot-updater/apple-helper@0.33.1
  - @hot-updater/cli-tools@0.33.1
  - @hot-updater/core@0.33.1

## 0.33.0

### Minor Changes

- 0eb4639: Unify doctor infrastructure update targets so runtime and migration requirements share one version target source.

### Patch Changes

- e914f56: Avoid redundant provider bundle reads during update checks and teach doctor to flag server runtime redeploy requirements.
- Updated dependencies [070a86f]
- Updated dependencies [e914f56]
- Updated dependencies [2b9944a]
  - @hot-updater/cli-tools@0.33.0
  - @hot-updater/server@0.33.0
  - @hot-updater/plugin-core@0.33.0
  - @hot-updater/console@0.33.0
  - @hot-updater/android-helper@0.33.0
  - @hot-updater/apple-helper@0.33.0
  - @hot-updater/core@0.33.0

## 0.32.0

### Patch Changes

- 4e6d2ec: Use deterministic content-addressed storage keys for manifest assets, require storage plugins to implement object existence checks, skip uploads when the object already exists, limit deploy upload concurrency, stream hashing/compression work to reduce memory pressure, and report upload progress through 100%.
- c6d10fc: fix(fingerprint): load `@expo/fingerprint` as an optional peer dependency for fingerprint commands
- 8e87b5f: Harden Supabase init by enabling RLS for Hot Updater tables, pinning
  Supabase function search paths, and generating service-role env naming while
  failing skipped legacy configs before writing the service-role env key.
- Updated dependencies [4e6d2ec]
- Updated dependencies [499e139]
  - @hot-updater/cli-tools@0.32.0
  - @hot-updater/console@0.32.0
  - @hot-updater/plugin-core@0.32.0
  - @hot-updater/server@0.32.0
  - @hot-updater/android-helper@0.32.0
  - @hot-updater/apple-helper@0.32.0
  - @hot-updater/core@0.32.0

## 0.31.4

### Patch Changes

- @hot-updater/android-helper@0.31.4
- @hot-updater/apple-helper@0.31.4
- @hot-updater/cli-tools@0.31.4
- @hot-updater/console@0.31.4
- @hot-updater/core@0.31.4
- @hot-updater/server@0.31.4
- @hot-updater/plugin-core@0.31.4

## 0.31.3

### Patch Changes

- d5d9c48: fix(hot-updater): match patch bases by semver compatibility
  - @hot-updater/android-helper@0.31.3
  - @hot-updater/apple-helper@0.31.3
  - @hot-updater/cli-tools@0.31.3
  - @hot-updater/console@0.31.3
  - @hot-updater/core@0.31.3
  - @hot-updater/server@0.31.3
  - @hot-updater/plugin-core@0.31.3

## 0.31.2

### Patch Changes

- fe365ef: Bundle CLI-only dependencies so Expo projects do not install a duplicate
  `@expo/fingerprint` through `hot-updater`.
- 0084a78: tree-shake sql-formatter dialects
  - @hot-updater/android-helper@0.31.2
  - @hot-updater/apple-helper@0.31.2
  - @hot-updater/cli-tools@0.31.2
  - @hot-updater/console@0.31.2
  - @hot-updater/core@0.31.2
  - @hot-updater/server@0.31.2
  - @hot-updater/plugin-core@0.31.2

## 0.31.1

### Patch Changes

- 8eb21d7: Check native OTA wiring in doctor
  - @hot-updater/android-helper@0.31.1
  - @hot-updater/apple-helper@0.31.1
  - @hot-updater/cli-tools@0.31.1
  - @hot-updater/console@0.31.1
  - @hot-updater/core@0.31.1
  - @hot-updater/server@0.31.1
  - @hot-updater/plugin-core@0.31.1

## 0.31.0

### Minor Changes

- 5b0a0f5: Add signed manifest-based diff update support across deploy, server, provider storage, console tooling, and React Native runtime.

### Patch Changes

- 5b0a0f5: Add CLI bundle inspection and metadata mutation commands for automation:
  `bundle show`, `bundle update`, and `bundle delete`.
- Updated dependencies [5b0a0f5]
- Updated dependencies [5b0a0f5]
  - @hot-updater/core@0.31.0
  - @hot-updater/console@0.31.0
  - @hot-updater/server@0.31.0
  - @hot-updater/android-helper@0.31.0
  - @hot-updater/cli-tools@0.31.0
  - @hot-updater/plugin-core@0.31.0
  - @hot-updater/apple-helper@0.31.0

## 0.30.12

### Patch Changes

- @hot-updater/android-helper@0.30.12
- @hot-updater/apple-helper@0.30.12
- @hot-updater/cli-tools@0.30.12
- @hot-updater/console@0.30.12
- @hot-updater/core@0.30.12
- @hot-updater/server@0.30.12
- @hot-updater/plugin-core@0.30.12

## 0.30.11

### Patch Changes

- eb32048: fix(cli): `deploy` falls back to the auto-detected target app version in non-interactive mode

  Previously, running `hot-updater deploy` without `-t` and without `-i` errored with
  "Target app version not found", even though `getDefaultTargetAppVersion` had already
  extracted the version from the binary's native files (Info.plist for iOS, build.gradle
  for Android) for use as the interactive prompt's placeholder. CI deploys had to
  either pass `-t` explicitly or scrape the version out of package.json.

  Now the resolution order is: explicit `-t` → interactive prompt (with the auto-detected
  value as placeholder) → auto-detected default → clear error if the native config is
  unreadable. Existing `-t` and `-i` invocations are unchanged.
  - @hot-updater/android-helper@0.30.11
  - @hot-updater/apple-helper@0.30.11
  - @hot-updater/cli-tools@0.30.11
  - @hot-updater/console@0.30.11
  - @hot-updater/core@0.30.11
  - @hot-updater/server@0.30.11
  - @hot-updater/plugin-core@0.30.11

## 0.30.10

### Patch Changes

- 677271a: feat(cli): `deploy` runs both platforms when `-p` is omitted

  `hot-updater deploy` (without `-p ios` or `-p android`) now deploys ios then android sequentially. If ios fails, android is not attempted — the channel is never left half-updated. This is the typical CI/CD invocation pattern.

  ```
  hot-updater deploy -c dev               # ios + android, sequential, abort-on-first-failure
  hot-updater deploy -p ios -c dev        # unchanged: single platform
  hot-updater deploy -i -c dev            # unchanged: interactive prompt for one platform
  ```

  Existing `-p ios` / `-p android` invocations are unchanged; `-i` (interactive) still prompts for a single platform. The change is purely in the no-`-p`-no-`-i` path, which previously errored with "Platform not found" — that error path is now the multi-platform deploy.

- fb780c1: feat(cli): add `bundle promote` command

  Move or copy a bundle to a different channel from the CLI, mirroring the console's Promote-to-Channel UI.

  ```
  hot-updater bundle promote <bundle-id> -t <target-channel> [-a copy|move] [-y]
  ```

  - The bundle id is positional — the bundle carries its own source channel, so no `--source` flag is needed.
  - `--action copy` (default) creates a new bundle id on the target channel and leaves the original in place — CodePush-promote semantics.
  - `--action move` updates the bundle's `channel` column without creating a new bundle (D1-only mutation; no R2 work).
  - Wraps the `promoteBundle` function from `@hot-updater/cli-tools`, so the CLI and console use one implementation. Surfaces the underlying `LEGACY_BUNDLE_ERROR` and signing/storage configuration errors directly.

  Pre-flight: rejects bundle-already-on-target, missing bundle id, empty target. Refuses to mutate without `-y` in a non-TTY shell. Lives under the `bundle` namespace alongside `bundle list/disable/enable` since the noun being mutated is the bundle (its channel attribute, or a copy of it).

- 014430a: fix(cli): make multi-platform deploy a first-class flow

  `hot-updater deploy` now handles the no-`-p` path inside the deploy command
  itself instead of looping from the CLI entrypoint. This keeps the banner and
  success output consistent, makes it explicit that iOS and Android are deployed
  sequentially, and writes local bundle archives to platform-specific output
  directories so one platform no longer overwrites the other.
  - @hot-updater/android-helper@0.30.10
  - @hot-updater/apple-helper@0.30.10
  - @hot-updater/cli-tools@0.30.10
  - @hot-updater/console@0.30.10
  - @hot-updater/core@0.30.10
  - @hot-updater/server@0.30.10
  - @hot-updater/plugin-core@0.30.10

## 0.30.9

### Patch Changes

- @hot-updater/android-helper@0.30.9
- @hot-updater/apple-helper@0.30.9
- @hot-updater/cli-tools@0.30.9
- @hot-updater/console@0.30.9
- @hot-updater/core@0.30.9
- @hot-updater/server@0.30.9
- @hot-updater/plugin-core@0.30.9

## 0.30.8

### Patch Changes

- 655b97c: feat(cli): add `bundle list/disable/enable` commands

  Adds three subcommands under a new top-level `bundle` namespace:
  - `hot-updater bundle list [-c <channel>] [-p <ios|android>] [--limit <n>]` — tabulated listing of bundles, most recent first. `--limit` validation uses commander's idiomatic `InvalidArgumentError` shape.
  - `hot-updater bundle disable <bundle-id> [-y]` — disable a single bundle. Refuses to mutate without `-y` in a non-TTY shell. Re-reads the bundle after `commitBundle` and exits non-zero if the change did not take effect; treats a mid-flight deletion as success.
  - `hot-updater bundle enable <bundle-id> [-y]` — re-enable a previously disabled bundle.

  All three commands load config via `loadConfig(null)` (matching the `console` command's idiom) since they are not platform-scoped operations. They use the existing `DatabasePlugin` interface (`getBundles`, `getBundleById`, `updateBundle`, `commitBundle`), so they work against every supported provider with no plugin-side changes. The `--platform` option is the shared `platformCommandOption` already used by `deploy`. `onUnmount` is wrapped in its own try/catch so cleanup errors never mask the originating mutation error. Help text documents the read-mutate-verify contract and exit codes (0 = success, 1 = error, 2 = user-aborted).

- 8318094: feat(cli): add `rollback <channel>` command

  Disables the most recent enabled bundle on a channel for each requested platform.

  ```
  hot-updater rollback <channel> [-p ios|android] [-y] [--confirm-revert-to-binary] [--target <bundle-id>]
  ```

  Behavior:
  - **Read phase** loads up to two most-recent enabled bundles per (channel, platform) so the operator can see what would become active after rollback.
  - **Validate phase** refuses with non-zero exit if any (channel, platform) would have **no** enabled bundles after the rollback unless `--confirm-revert-to-binary` is passed. The error message names both safe escape hatches in priority order: `-p <unaffected>` first, then `--confirm-revert-to-binary`.
  - **Mutate phase** queues `updateBundle({ enabled: false })` for each target and commits once. Note: `DatabasePlugin.commitBundle` runs ops sequentially in the underlying provider, so atomicity across platforms is **not** guaranteed. The mutate is wrapped in a try/catch so a mid-commit throw still falls through to the verify phase.
  - **Verify phase** re-reads each target. Distinguishes three states — disabled (success), still-enabled (failure), and gone (success: a deleted bundle satisfies the rollback intent). Surfaces partial-failure state explicitly with non-zero exit and per-platform `FAILED` lines naming the exact retry command, including a `--target <bundle-id>` flag for scoped retry.

  Refuses to mutate without `-y` in a non-TTY shell. `onUnmount` is wrapped in its own try/catch so cleanup errors never mask the originating mutation error. Help text documents the four-phase contract and exit codes (0 = success, 1 = error, 2 = user-aborted).

- deff7ab: feat(cli): cli design system
- 8318094: Feature - CLI Rollback
- Updated dependencies [6019156]
  - @hot-updater/cli-tools@0.30.8
  - @hot-updater/plugin-core@0.30.8
  - @hot-updater/console@0.30.8
  - @hot-updater/android-helper@0.30.8
  - @hot-updater/apple-helper@0.30.8
  - @hot-updater/server@0.30.8
  - @hot-updater/core@0.30.8

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

- Updated dependencies [03fd179]
  - @hot-updater/apple-helper@0.30.7
  - @hot-updater/cli-tools@0.30.7
  - @hot-updater/android-helper@0.30.7
  - @hot-updater/console@0.30.7
  - @hot-updater/core@0.30.7
  - @hot-updater/server@0.30.7
  - @hot-updater/plugin-core@0.30.7

## 0.30.6

### Patch Changes

- 82de1c6: fix(deps): widen `@expo/fingerprint` to caret range to allow dedupe with Expo SDK
  - @hot-updater/android-helper@0.30.6
  - @hot-updater/apple-helper@0.30.6
  - @hot-updater/cli-tools@0.30.6
  - @hot-updater/console@0.30.6
  - @hot-updater/core@0.30.6
  - @hot-updater/server@0.30.6
  - @hot-updater/plugin-core@0.30.6

## 0.30.5

### Patch Changes

- @hot-updater/android-helper@0.30.5
- @hot-updater/apple-helper@0.30.5
- @hot-updater/cli-tools@0.30.5
- @hot-updater/console@0.30.5
- @hot-updater/core@0.30.5
- @hot-updater/server@0.30.5
- @hot-updater/plugin-core@0.30.5

## 0.30.4

### Patch Changes

- @hot-updater/android-helper@0.30.4
- @hot-updater/apple-helper@0.30.4
- @hot-updater/cli-tools@0.30.4
- @hot-updater/console@0.30.4
- @hot-updater/core@0.30.4
- @hot-updater/server@0.30.4
- @hot-updater/plugin-core@0.30.4

## 0.30.3

### Patch Changes

- @hot-updater/android-helper@0.30.3
- @hot-updater/apple-helper@0.30.3
- @hot-updater/cli-tools@0.30.3
- @hot-updater/console@0.30.3
- @hot-updater/core@0.30.3
- @hot-updater/server@0.30.3
- @hot-updater/plugin-core@0.30.3

## 0.30.2

### Patch Changes

- @hot-updater/android-helper@0.30.2
- @hot-updater/apple-helper@0.30.2
- @hot-updater/cli-tools@0.30.2
- @hot-updater/console@0.30.2
- @hot-updater/core@0.30.2
- @hot-updater/server@0.30.2
- @hot-updater/plugin-core@0.30.2

## 0.30.1

### Patch Changes

- 5a7cb26: feat(cli): check infra in hot-updater doctor
- Updated dependencies [35b8720]
  - @hot-updater/console@0.30.1
  - @hot-updater/android-helper@0.30.1
  - @hot-updater/apple-helper@0.30.1
  - @hot-updater/cli-tools@0.30.1
  - @hot-updater/core@0.30.1
  - @hot-updater/server@0.30.1
  - @hot-updater/plugin-core@0.30.1

## 0.30.0

### Minor Changes

- 83c01c8: fix: keep target cohorts additive to rollout

### Patch Changes

- Updated dependencies [83c01c8]
  - @hot-updater/console@0.30.0
  - @hot-updater/server@0.30.0
  - @hot-updater/core@0.30.0
  - @hot-updater/android-helper@0.30.0
  - @hot-updater/apple-helper@0.30.0
  - @hot-updater/cli-tools@0.30.0
  - @hot-updater/plugin-core@0.30.0

## 0.29.8

### Patch Changes

- Updated dependencies [28e14aa]
  - @hot-updater/console@0.29.8
  - @hot-updater/android-helper@0.29.8
  - @hot-updater/apple-helper@0.29.8
  - @hot-updater/cli-tools@0.29.8
  - @hot-updater/core@0.29.8
  - @hot-updater/server@0.29.8
  - @hot-updater/plugin-core@0.29.8

## 0.29.7

### Patch Changes

- @hot-updater/android-helper@0.29.7
- @hot-updater/apple-helper@0.29.7
- @hot-updater/cli-tools@0.29.7
- @hot-updater/console@0.29.7
- @hot-updater/core@0.29.7
- @hot-updater/server@0.29.7
- @hot-updater/plugin-core@0.29.7

## 0.29.6

### Patch Changes

- 5a2d37c: Fix the local `fix-ci` runner so the integration step finishes cleanly after
  background emulator processes exit.
- Updated dependencies [80cce61]
  - @hot-updater/cli-tools@0.29.6
  - @hot-updater/android-helper@0.29.6
  - @hot-updater/apple-helper@0.29.6
  - @hot-updater/console@0.29.6
  - @hot-updater/core@0.29.6
  - @hot-updater/server@0.29.6
  - @hot-updater/plugin-core@0.29.6

## 0.29.5

### Patch Changes

- Updated dependencies [52208f4]
  - @hot-updater/server@0.29.5
  - @hot-updater/plugin-core@0.29.5
  - @hot-updater/android-helper@0.29.5
  - @hot-updater/apple-helper@0.29.5
  - @hot-updater/cli-tools@0.29.5
  - @hot-updater/console@0.29.5
  - @hot-updater/core@0.29.5

## 0.29.4

### Patch Changes

- @hot-updater/android-helper@0.29.4
- @hot-updater/apple-helper@0.29.4
- @hot-updater/cli-tools@0.29.4
- @hot-updater/console@0.29.4
- @hot-updater/core@0.29.4
- @hot-updater/server@0.29.4
- @hot-updater/plugin-core@0.29.4

## 0.29.3

### Patch Changes

- ca2e17d: refactor(cli): deploy log align print
- Updated dependencies [d1ffb83]
  - @hot-updater/plugin-core@0.29.3
  - @hot-updater/console@0.29.3
  - @hot-updater/server@0.29.3
  - @hot-updater/android-helper@0.29.3
  - @hot-updater/apple-helper@0.29.3
  - @hot-updater/cli-tools@0.29.3
  - @hot-updater/core@0.29.3

## 0.29.2

### Patch Changes

- 2a1bc80: fix: node deps bundling
- Updated dependencies [2a1bc80]
  - @hot-updater/cli-tools@0.29.2
  - @hot-updater/core@0.29.2
  - @hot-updater/server@0.29.2
  - @hot-updater/plugin-core@0.29.2
  - @hot-updater/android-helper@0.29.2
  - @hot-updater/apple-helper@0.29.2
  - @hot-updater/console@0.29.2

## 0.29.1

### Patch Changes

- @hot-updater/android-helper@0.29.1
- @hot-updater/apple-helper@0.29.1
- @hot-updater/cli-tools@0.29.1
- @hot-updater/console@0.29.1
- @hot-updater/core@0.29.1
- @hot-updater/server@0.29.1
- @hot-updater/plugin-core@0.29.1

## 0.29.0

### Minor Changes

- a935992: feat: Rollout feature with control from 1% to 100%

### Patch Changes

- d0fe908: fix(console): rebuild copied bundles with fresh uuidv7 ids
- Updated dependencies [a935992]
- Updated dependencies [d0fe908]
- Updated dependencies [a935992]
  - @hot-updater/plugin-core@0.29.0
  - @hot-updater/cli-tools@0.29.0
  - @hot-updater/console@0.29.0
  - @hot-updater/server@0.29.0
  - @hot-updater/core@0.29.0
  - @hot-updater/android-helper@0.29.0
  - @hot-updater/apple-helper@0.29.0

## 0.28.0

### Patch Changes

- @hot-updater/android-helper@0.28.0
- @hot-updater/apple-helper@0.28.0
- @hot-updater/cli-tools@0.28.0
- @hot-updater/console@0.28.0
- @hot-updater/core@0.28.0
- @hot-updater/server@0.28.0
- @hot-updater/plugin-core@0.28.0

## 0.27.1

### Patch Changes

- @hot-updater/server@0.27.1
- @hot-updater/android-helper@0.27.1
- @hot-updater/apple-helper@0.27.1
- @hot-updater/cli-tools@0.27.1
- @hot-updater/console@0.27.1
- @hot-updater/core@0.27.1
- @hot-updater/plugin-core@0.27.1

## 0.27.0

### Minor Changes

- 81f9437: feat(android): for safe reloading, Android reloads the process (#869)

### Patch Changes

- Updated dependencies [81f9437]
  - @hot-updater/android-helper@0.27.0
  - @hot-updater/apple-helper@0.27.0
  - @hot-updater/cli-tools@0.27.0
  - @hot-updater/console@0.27.0
  - @hot-updater/core@0.27.0
  - @hot-updater/server@0.27.0
  - @hot-updater/plugin-core@0.27.0

## 0.26.2

### Patch Changes

- @hot-updater/server@0.26.2
- @hot-updater/android-helper@0.26.2
- @hot-updater/apple-helper@0.26.2
- @hot-updater/cli-tools@0.26.2
- @hot-updater/console@0.26.2
- @hot-updater/core@0.26.2
- @hot-updater/plugin-core@0.26.2

## 0.26.1

### Patch Changes

- @hot-updater/android-helper@0.26.1
- @hot-updater/apple-helper@0.26.1
- @hot-updater/cli-tools@0.26.1
- @hot-updater/console@0.26.1
- @hot-updater/core@0.26.1
- @hot-updater/server@0.26.1
- @hot-updater/plugin-core@0.26.1

## 0.26.0

### Patch Changes

- @hot-updater/android-helper@0.26.0
- @hot-updater/apple-helper@0.26.0
- @hot-updater/cli-tools@0.26.0
- @hot-updater/console@0.26.0
- @hot-updater/core@0.26.0
- @hot-updater/server@0.26.0
- @hot-updater/plugin-core@0.26.0

## 0.25.14

### Patch Changes

- @hot-updater/server@0.25.14
- @hot-updater/android-helper@0.25.14
- @hot-updater/apple-helper@0.25.14
- @hot-updater/cli-tools@0.25.14
- @hot-updater/console@0.25.14
- @hot-updater/core@0.25.14
- @hot-updater/plugin-core@0.25.14

## 0.25.13

### Patch Changes

- 169b019: chore: bump fast-xml-parser
- Updated dependencies [169b019]
  - @hot-updater/apple-helper@0.25.13
  - @hot-updater/android-helper@0.25.13
  - @hot-updater/cli-tools@0.25.13
  - @hot-updater/console@0.25.13
  - @hot-updater/core@0.25.13
  - @hot-updater/server@0.25.13
  - @hot-updater/plugin-core@0.25.13

## 0.25.12

### Patch Changes

- 38b2af0: fix(expo): android template SDK 55
  - @hot-updater/android-helper@0.25.12
  - @hot-updater/apple-helper@0.25.12
  - @hot-updater/cli-tools@0.25.12
  - @hot-updater/console@0.25.12
  - @hot-updater/core@0.25.12
  - @hot-updater/server@0.25.12
  - @hot-updater/plugin-core@0.25.12

## 0.25.11

### Patch Changes

- @hot-updater/android-helper@0.25.11
- @hot-updater/apple-helper@0.25.11
- @hot-updater/cli-tools@0.25.11
- @hot-updater/console@0.25.11
- @hot-updater/core@0.25.11
- @hot-updater/server@0.25.11
- @hot-updater/plugin-core@0.25.11

## 0.25.10

### Patch Changes

- Updated dependencies [90f9610]
- Updated dependencies [03c5adc]
  - @hot-updater/android-helper@0.25.10
  - @hot-updater/apple-helper@0.25.10
  - @hot-updater/cli-tools@0.25.10
  - @hot-updater/plugin-core@0.25.10
  - @hot-updater/console@0.25.10
  - @hot-updater/server@0.25.10
  - @hot-updater/core@0.25.10

## 0.25.9

### Patch Changes

- 6b22072: Change the default value of `podInstalls` option in iOS native build scheme to `false`
- Updated dependencies [6b22072]
  - @hot-updater/apple-helper@0.25.9
  - @hot-updater/plugin-core@0.25.9
  - @hot-updater/android-helper@0.25.9
  - @hot-updater/cli-tools@0.25.9
  - @hot-updater/console@0.25.9
  - @hot-updater/server@0.25.9
  - @hot-updater/core@0.25.9

## 0.25.8

### Patch Changes

- @hot-updater/android-helper@0.25.8
- @hot-updater/apple-helper@0.25.8
- @hot-updater/cli-tools@0.25.8
- @hot-updater/console@0.25.8
- @hot-updater/core@0.25.8
- @hot-updater/server@0.25.8
- @hot-updater/plugin-core@0.25.8

## 0.25.7

### Patch Changes

- @hot-updater/android-helper@0.25.7
- @hot-updater/apple-helper@0.25.7
- @hot-updater/cli-tools@0.25.7
- @hot-updater/console@0.25.7
- @hot-updater/core@0.25.7
- @hot-updater/server@0.25.7
- @hot-updater/plugin-core@0.25.7

## 0.25.6

### Patch Changes

- c7a0cc5: fix(cli): even though "provider: 'mysql'" is configured, the error still shows the dialect as postgresql
  - @hot-updater/android-helper@0.25.6
  - @hot-updater/apple-helper@0.25.6
  - @hot-updater/cli-tools@0.25.6
  - @hot-updater/console@0.25.6
  - @hot-updater/core@0.25.6
  - @hot-updater/server@0.25.6
  - @hot-updater/plugin-core@0.25.6

## 0.25.5

### Patch Changes

- 8041bab: fix(cli): function parse$4 expects an xml, but some inputs come as binary as well
  - @hot-updater/android-helper@0.25.5
  - @hot-updater/apple-helper@0.25.5
  - @hot-updater/cli-tools@0.25.5
  - @hot-updater/console@0.25.5
  - @hot-updater/core@0.25.5
  - @hot-updater/server@0.25.5
  - @hot-updater/plugin-core@0.25.5

## 0.25.4

### Patch Changes

- Updated dependencies [8c83ff2]
  - @hot-updater/cli-tools@0.25.4
  - @hot-updater/console@0.25.4
  - @hot-updater/server@0.25.4
  - @hot-updater/core@0.25.4
  - @hot-updater/plugin-core@0.25.4

## 0.25.3

### Patch Changes

- cddc20f: feat: add critical conflict check for expo-updates
  - @hot-updater/cli-tools@0.25.3
  - @hot-updater/console@0.25.3
  - @hot-updater/core@0.25.3
  - @hot-updater/server@0.25.3
  - @hot-updater/plugin-core@0.25.3

## 0.25.2

### Patch Changes

- @hot-updater/cli-tools@0.25.2
- @hot-updater/console@0.25.2
- @hot-updater/core@0.25.2
- @hot-updater/server@0.25.2
- @hot-updater/plugin-core@0.25.2

## 0.25.1

### Patch Changes

- @hot-updater/cli-tools@0.25.1
- @hot-updater/console@0.25.1
- @hot-updater/core@0.25.1
- @hot-updater/server@0.25.1
- @hot-updater/plugin-core@0.25.1

## 0.25.0

### Minor Changes

- d22b48a: feat(expo): expo 'use dom' correct ota update

### Patch Changes

- @hot-updater/cli-tools@0.25.0
- @hot-updater/console@0.25.0
- @hot-updater/core@0.25.0
- @hot-updater/server@0.25.0
- @hot-updater/plugin-core@0.25.0

## 0.24.7

### Patch Changes

- 294e324: fix: update babel plugin path in documentation and plugin files
- Updated dependencies [294e324]
  - @hot-updater/cli-tools@0.24.7
  - @hot-updater/console@0.24.7
  - @hot-updater/core@0.24.7
  - @hot-updater/server@0.24.7
  - @hot-updater/plugin-core@0.24.7

## 0.24.6

### Patch Changes

- 9d7b6af: feat(aws): sso template with fromSSO
- 962ecdd: fix(expo): fingerprint autolinking for expo
- Updated dependencies [9d7b6af]
  - @hot-updater/cli-tools@0.24.6
  - @hot-updater/console@0.24.6
  - @hot-updater/server@0.24.6
  - @hot-updater/core@0.24.6
  - @hot-updater/plugin-core@0.24.6

## 0.24.5

### Patch Changes

- f755c3c: Add build\* to default fingerprint ignore paths
  - @hot-updater/cli-tools@0.24.5
  - @hot-updater/console@0.24.5
  - @hot-updater/core@0.24.5
  - @hot-updater/server@0.24.5
  - @hot-updater/plugin-core@0.24.5

## 0.24.4

### Patch Changes

- Updated dependencies [7ed539f]
  - @hot-updater/plugin-core@0.24.4
  - @hot-updater/cli-tools@0.24.4
  - @hot-updater/console@0.24.4
  - @hot-updater/server@0.24.4
  - @hot-updater/core@0.24.4

## 0.24.3

### Patch Changes

- @hot-updater/cli-tools@0.24.3
- @hot-updater/console@0.24.3
- @hot-updater/core@0.24.3
- @hot-updater/server@0.24.3
- @hot-updater/plugin-core@0.24.3

## 0.24.2

### Patch Changes

- @hot-updater/cli-tools@0.24.2
- @hot-updater/console@0.24.2
- @hot-updater/core@0.24.2
- @hot-updater/server@0.24.2
- @hot-updater/plugin-core@0.24.2

## 0.24.1

### Patch Changes

- @hot-updater/cli-tools@0.24.1
- @hot-updater/console@0.24.1
- @hot-updater/core@0.24.1
- @hot-updater/server@0.24.1
- @hot-updater/plugin-core@0.24.1

## 0.24.0

### Patch Changes

- @hot-updater/cli-tools@0.24.0
- @hot-updater/console@0.24.0
- @hot-updater/core@0.24.0
- @hot-updater/server@0.24.0
- @hot-updater/plugin-core@0.24.0

## 0.23.1

### Patch Changes

- 7fa9a20: feat(expo): bundle-signing supports cng plugin
  - @hot-updater/cli-tools@0.23.1
  - @hot-updater/console@0.23.1
  - @hot-updater/core@0.23.1
  - @hot-updater/server@0.23.1
  - @hot-updater/plugin-core@0.23.1

## 0.23.0

### Minor Changes

- e41fb6b: feat: add bundle signing for cryptographic OTA verification

### Patch Changes

- Updated dependencies [e41fb6b]
  - @hot-updater/core@0.23.0
  - @hot-updater/console@0.23.0
  - @hot-updater/server@0.23.0
  - @hot-updater/plugin-core@0.23.0
  - @hot-updater/cli-tools@0.23.0

## 0.22.2

### Patch Changes

- @hot-updater/cli-tools@0.22.2
- @hot-updater/console@0.22.2
- @hot-updater/core@0.22.2
- @hot-updater/server@0.22.2
- @hot-updater/aws@0.22.2
- @hot-updater/cloudflare@0.22.2
- @hot-updater/firebase@0.22.2
- @hot-updater/plugin-core@0.22.2
- @hot-updater/supabase@0.22.2

## 0.22.1

### Patch Changes

- Updated dependencies [422bf89]
  - @hot-updater/console@0.22.1
  - @hot-updater/cli-tools@0.22.1
  - @hot-updater/core@0.22.1
  - @hot-updater/server@0.22.1
  - @hot-updater/aws@0.22.1
  - @hot-updater/cloudflare@0.22.1
  - @hot-updater/firebase@0.22.1
  - @hot-updater/plugin-core@0.22.1
  - @hot-updater/supabase@0.22.1

## 0.22.0

### Patch Changes

- Updated dependencies [32ad614]
  - @hot-updater/server@0.22.0
  - @hot-updater/cli-tools@0.22.0
  - @hot-updater/console@0.22.0
  - @hot-updater/core@0.22.0
  - @hot-updater/aws@0.22.0
  - @hot-updater/cloudflare@0.22.0
  - @hot-updater/firebase@0.22.0
  - @hot-updater/plugin-core@0.22.0
  - @hot-updater/supabase@0.22.0

## 0.21.15

### Patch Changes

- Updated dependencies [a169f06]
  - @hot-updater/server@0.21.15
  - @hot-updater/cli-tools@0.21.15
  - @hot-updater/aws@0.21.15
  - @hot-updater/cloudflare@0.21.15
  - @hot-updater/firebase@0.21.15
  - @hot-updater/plugin-core@0.21.15
  - @hot-updater/console@0.21.15
  - @hot-updater/core@0.21.15
  - @hot-updater/supabase@0.21.15

## 0.21.14

### Patch Changes

- @hot-updater/cli-tools@0.21.14
- @hot-updater/console@0.21.14
- @hot-updater/core@0.21.14
- @hot-updater/server@0.21.14
- @hot-updater/aws@0.21.14
- @hot-updater/cloudflare@0.21.14
- @hot-updater/firebase@0.21.14
- @hot-updater/plugin-core@0.21.14
- @hot-updater/supabase@0.21.14

## 0.21.13

### Patch Changes

- 44f4e95: Fix processing of directory glob patterns on extraSources
  - @hot-updater/cli-tools@0.21.13
  - @hot-updater/console@0.21.13
  - @hot-updater/core@0.21.13
  - @hot-updater/server@0.21.13
  - @hot-updater/aws@0.21.13
  - @hot-updater/cloudflare@0.21.13
  - @hot-updater/firebase@0.21.13
  - @hot-updater/plugin-core@0.21.13
  - @hot-updater/supabase@0.21.13

## 0.21.12

### Patch Changes

- 56e849b: chore(server): storagePlugins to storages
- Updated dependencies [56e849b]
- Updated dependencies [5c4b98e]
  - @hot-updater/server@0.21.12
  - @hot-updater/plugin-core@0.21.12
  - @hot-updater/cloudflare@0.21.12
  - @hot-updater/firebase@0.21.12
  - @hot-updater/supabase@0.21.12
  - @hot-updater/aws@0.21.12
  - @hot-updater/cli-tools@0.21.12
  - @hot-updater/console@0.21.12
  - @hot-updater/core@0.21.12

## 0.21.11

### Patch Changes

- e2b67d7: fix(cli-tools): esm only package bundle
- 2905e47: feat(server): supports hot-updater database plugin style
- Updated dependencies [d6c3a65]
- Updated dependencies [7ee2830]
- Updated dependencies [e2b67d7]
- Updated dependencies [2905e47]
  - @hot-updater/cli-tools@0.21.11
  - @hot-updater/server@0.21.11
  - @hot-updater/console@0.21.11
  - @hot-updater/core@0.21.11
  - @hot-updater/aws@0.21.11
  - @hot-updater/cloudflare@0.21.11
  - @hot-updater/firebase@0.21.11
  - @hot-updater/plugin-core@0.21.11
  - @hot-updater/supabase@0.21.11

## 0.21.10

### Patch Changes

- Updated dependencies [5289b17]
  - @hot-updater/server@0.21.10
  - @hot-updater/cli-tools@0.21.10
  - @hot-updater/aws@0.21.10
  - @hot-updater/cloudflare@0.21.10
  - @hot-updater/firebase@0.21.10
  - @hot-updater/plugin-core@0.21.10
  - @hot-updater/console@0.21.10
  - @hot-updater/core@0.21.10
  - @hot-updater/supabase@0.21.10

## 0.21.9

### Patch Changes

- 396ae54: feat(cli): db generate --sql create only sql
- aa399a6: chore: deps picocolors
- Updated dependencies [aa399a6]
  - @hot-updater/plugin-core@0.21.9
  - @hot-updater/cli-tools@0.21.9
  - @hot-updater/console@0.21.9
  - @hot-updater/server@0.21.9
  - @hot-updater/aws@0.21.9
  - @hot-updater/cloudflare@0.21.9
  - @hot-updater/firebase@0.21.9
  - @hot-updater/supabase@0.21.9
  - @hot-updater/core@0.21.9

## 0.21.8

### Patch Changes

- 3fe8c81: feat(plugin-core): reduced deps for edge-runtime
- Updated dependencies [3fe8c81]
  - @hot-updater/plugin-core@0.21.8
  - @hot-updater/cli-tools@0.21.8
  - @hot-updater/cloudflare@0.21.8
  - @hot-updater/firebase@0.21.8
  - @hot-updater/aws@0.21.8
  - @hot-updater/console@0.21.8
  - @hot-updater/supabase@0.21.8
  - @hot-updater/core@0.21.8

## 0.21.7

### Patch Changes

- Updated dependencies [2b408f2]
  - @hot-updater/plugin-core@0.21.7
  - @hot-updater/cloudflare@0.21.7
  - @hot-updater/firebase@0.21.7
  - @hot-updater/supabase@0.21.7
  - @hot-updater/aws@0.21.7
  - @hot-updater/console@0.21.7
  - @hot-updater/core@0.21.7

## 0.21.6

### Patch Changes

- b12394d: feat(cli): create migration sql hot-updater generate-db
  - @hot-updater/console@0.21.6
  - @hot-updater/core@0.21.6
  - @hot-updater/aws@0.21.6
  - @hot-updater/cloudflare@0.21.6
  - @hot-updater/firebase@0.21.6
  - @hot-updater/plugin-core@0.21.6
  - @hot-updater/supabase@0.21.6

## 0.21.5

### Patch Changes

- fc2bd56: feat: Add disabled option to deploy command
- a253498: chore(cli): replace es-git with native Git commands
  - @hot-updater/console@0.21.5
  - @hot-updater/core@0.21.5
  - @hot-updater/aws@0.21.5
  - @hot-updater/cloudflare@0.21.5
  - @hot-updater/firebase@0.21.5
  - @hot-updater/plugin-core@0.21.5
  - @hot-updater/supabase@0.21.5

## 0.21.4

### Patch Changes

- Updated dependencies [5d3070a]
  - @hot-updater/plugin-core@0.21.4
  - @hot-updater/aws@0.21.4
  - @hot-updater/cloudflare@0.21.4
  - @hot-updater/firebase@0.21.4
  - @hot-updater/console@0.21.4
  - @hot-updater/supabase@0.21.4
  - @hot-updater/core@0.21.4

## 0.21.3

### Patch Changes

- @hot-updater/console@0.21.3
- @hot-updater/core@0.21.3
- @hot-updater/aws@0.21.3
- @hot-updater/cloudflare@0.21.3
- @hot-updater/firebase@0.21.3
- @hot-updater/plugin-core@0.21.3
- @hot-updater/supabase@0.21.3

## 0.21.2

### Patch Changes

- Updated dependencies [b72da6e]
  - @hot-updater/firebase@0.21.2
  - @hot-updater/console@0.21.2
  - @hot-updater/core@0.21.2
  - @hot-updater/aws@0.21.2
  - @hot-updater/cloudflare@0.21.2
  - @hot-updater/plugin-core@0.21.2
  - @hot-updater/supabase@0.21.2

## 0.21.1

### Patch Changes

- Updated dependencies [7b7bc48]
  - @hot-updater/plugin-core@0.21.1
  - @hot-updater/console@0.21.1
  - @hot-updater/aws@0.21.1
  - @hot-updater/cloudflare@0.21.1
  - @hot-updater/firebase@0.21.1
  - @hot-updater/supabase@0.21.1
  - @hot-updater/core@0.21.1

## 0.22.0

### Minor Changes

- 610b2dd: feat: supports `compressStrategy` => `tar.br` (brotli) / `tar.gz` (gzip)
- 036f8f0: feat: support `@hot-updater/server` for self-hosted (WIP)

### Patch Changes

- Updated dependencies [610b2dd]
- Updated dependencies [afb084b]
- Updated dependencies [036f8f0]
  - @hot-updater/plugin-core@0.22.0
  - @hot-updater/cloudflare@0.22.0
  - @hot-updater/firebase@0.22.0
  - @hot-updater/supabase@0.22.0
  - @hot-updater/aws@0.22.0
  - @hot-updater/console@0.22.0
  - @hot-updater/core@0.22.0

## 0.20.15

### Patch Changes

- Updated dependencies [526a5ba]
- Updated dependencies [ddf6f2c]
  - @hot-updater/plugin-core@0.20.15
  - @hot-updater/console@0.20.15
  - @hot-updater/aws@0.20.15
  - @hot-updater/cloudflare@0.20.15
  - @hot-updater/firebase@0.20.15
  - @hot-updater/supabase@0.20.15
  - @hot-updater/core@0.20.15

## 0.20.14

### Patch Changes

- Updated dependencies [a61fa0e]
  - @hot-updater/plugin-core@0.20.14
  - @hot-updater/aws@0.20.14
  - @hot-updater/console@0.20.14
  - @hot-updater/cloudflare@0.20.14
  - @hot-updater/firebase@0.20.14
  - @hot-updater/supabase@0.20.14
  - @hot-updater/core@0.20.14

## 0.20.13

### Patch Changes

- @hot-updater/console@0.20.13
- @hot-updater/core@0.20.13
- @hot-updater/aws@0.20.13
- @hot-updater/cloudflare@0.20.13
- @hot-updater/firebase@0.20.13
- @hot-updater/plugin-core@0.20.13
- @hot-updater/supabase@0.20.13

## 0.20.12

### Patch Changes

- @hot-updater/console@0.20.12
- @hot-updater/core@0.20.12
- @hot-updater/aws@0.20.12
- @hot-updater/cloudflare@0.20.12
- @hot-updater/firebase@0.20.12
- @hot-updater/plugin-core@0.20.12
- @hot-updater/supabase@0.20.12

## 0.20.11

### Patch Changes

- afb3a6e: fix(fingerprint): separate fingerprint generation for cng
- cb9c05b: feat(fingerprint): bring back ignorePaths
- Updated dependencies [cb9c05b]
  - @hot-updater/plugin-core@0.20.11
  - @hot-updater/console@0.20.11
  - @hot-updater/aws@0.20.11
  - @hot-updater/cloudflare@0.20.11
  - @hot-updater/firebase@0.20.11
  - @hot-updater/supabase@0.20.11
  - @hot-updater/core@0.20.11

## 0.20.10

### Patch Changes

- 6b5435c: Ignore android/ios folder changes in fingerprint to avoid mismatch after prebuild
  - @hot-updater/console@0.20.10
  - @hot-updater/core@0.20.10
  - @hot-updater/aws@0.20.10
  - @hot-updater/cloudflare@0.20.10
  - @hot-updater/firebase@0.20.10
  - @hot-updater/plugin-core@0.20.10
  - @hot-updater/supabase@0.20.10

## 0.20.9

### Patch Changes

- Updated dependencies [5cbea75]
  - @hot-updater/cloudflare@0.20.9
  - @hot-updater/console@0.20.9
  - @hot-updater/core@0.20.9
  - @hot-updater/aws@0.20.9
  - @hot-updater/firebase@0.20.9
  - @hot-updater/plugin-core@0.20.9
  - @hot-updater/supabase@0.20.9

## 0.20.8

### Patch Changes

- ad7c999: feat(fingerprint): calculate OTA fingerprint only in native module
- Updated dependencies [ad7c999]
  - @hot-updater/plugin-core@0.20.8
  - @hot-updater/console@0.20.8
  - @hot-updater/aws@0.20.8
  - @hot-updater/cloudflare@0.20.8
  - @hot-updater/firebase@0.20.8
  - @hot-updater/supabase@0.20.8
  - @hot-updater/core@0.20.8

## 0.20.7

### Patch Changes

- a92992c: chore(tsdown): failOnWarn true
- Updated dependencies [a92992c]
  - @hot-updater/plugin-core@0.20.7
  - @hot-updater/cloudflare@0.20.7
  - @hot-updater/console@0.20.7
  - @hot-updater/firebase@0.20.7
  - @hot-updater/supabase@0.20.7
  - @hot-updater/core@0.20.7
  - @hot-updater/aws@0.20.7

## 0.20.6

### Patch Changes

- Updated dependencies [6a905d8]
  - @hot-updater/plugin-core@0.20.6
  - @hot-updater/console@0.20.6
  - @hot-updater/aws@0.20.6
  - @hot-updater/cloudflare@0.20.6
  - @hot-updater/firebase@0.20.6
  - @hot-updater/supabase@0.20.6
  - @hot-updater/core@0.20.6

## 0.20.5

### Patch Changes

- @hot-updater/console@0.20.5
- @hot-updater/core@0.20.5
- @hot-updater/aws@0.20.5
- @hot-updater/cloudflare@0.20.5
- @hot-updater/firebase@0.20.5
- @hot-updater/plugin-core@0.20.5
- @hot-updater/supabase@0.20.5

## 0.20.4

### Patch Changes

- 5314b31: feat(rock): intergration formerly rnef
- Updated dependencies [5314b31]
- Updated dependencies [711392b]
  - @hot-updater/plugin-core@0.20.4
  - @hot-updater/cloudflare@0.20.4
  - @hot-updater/firebase@0.20.4
  - @hot-updater/supabase@0.20.4
  - @hot-updater/aws@0.20.4
  - @hot-updater/console@0.20.4
  - @hot-updater/core@0.20.4

## 0.20.3

### Patch Changes

- e63056a: fix(cli): platform parser from hot-updater.config
- Updated dependencies [e63056a]
  - @hot-updater/plugin-core@0.20.3
  - @hot-updater/console@0.20.3
  - @hot-updater/aws@0.20.3
  - @hot-updater/cloudflare@0.20.3
  - @hot-updater/firebase@0.20.3
  - @hot-updater/supabase@0.20.3
  - @hot-updater/core@0.20.3

## 0.20.2

### Patch Changes

- Updated dependencies [0e78fb0]
  - @hot-updater/plugin-core@0.20.2
  - @hot-updater/console@0.20.2
  - @hot-updater/aws@0.20.2
  - @hot-updater/cloudflare@0.20.2
  - @hot-updater/firebase@0.20.2
  - @hot-updater/supabase@0.20.2
  - @hot-updater/core@0.20.2

## 0.20.1

### Patch Changes

- a3a4a28: feat(cli): set stringResourcePaths and infoPlistPaths in hot-updater.config.ts
- 42ff0e1: chore: bump @expo/fingerprint
- Updated dependencies [a3a4a28]
- Updated dependencies [b7b83ae]
  - @hot-updater/plugin-core@0.20.1
  - @hot-updater/console@0.20.1
  - @hot-updater/aws@0.20.1
  - @hot-updater/cloudflare@0.20.1
  - @hot-updater/firebase@0.20.1
  - @hot-updater/supabase@0.20.1
  - @hot-updater/core@0.20.1

## 0.20.0

### Patch Changes

- Updated dependencies [a0e538c]
- Updated dependencies [bc8e23d]
  - @hot-updater/cloudflare@0.20.0
  - @hot-updater/plugin-core@0.20.0
  - @hot-updater/console@0.20.0
  - @hot-updater/aws@0.20.0
  - @hot-updater/firebase@0.20.0
  - @hot-updater/supabase@0.20.0
  - @hot-updater/core@0.20.0

## 0.19.10

### Patch Changes

- 85b236d: skip gitignore and package json scripts
- 8d2d55a: Injectable minimum bundle id for Android
- Updated dependencies [a3c0901]
- Updated dependencies [4be92bd]
- Updated dependencies [2bc52e8]
  - @hot-updater/firebase@0.19.10
  - @hot-updater/cloudflare@0.19.10
  - @hot-updater/supabase@0.19.10
  - @hot-updater/aws@0.19.10
  - @hot-updater/plugin-core@0.19.10
  - @hot-updater/console@0.19.10
  - @hot-updater/core@0.19.10

## 0.19.9

### Patch Changes

- Updated dependencies [bcf6798]
  - @hot-updater/aws@0.19.9
  - @hot-updater/console@0.19.9
  - @hot-updater/core@0.19.9
  - @hot-updater/cloudflare@0.19.9
  - @hot-updater/firebase@0.19.9
  - @hot-updater/plugin-core@0.19.9
  - @hot-updater/supabase@0.19.9

## 0.19.8

### Patch Changes

- 4a6a769: feat(cli): show fingerprint diff
  - @hot-updater/console@0.19.8
  - @hot-updater/core@0.19.8
  - @hot-updater/aws@0.19.8
  - @hot-updater/cloudflare@0.19.8
  - @hot-updater/firebase@0.19.8
  - @hot-updater/plugin-core@0.19.8
  - @hot-updater/supabase@0.19.8

## 0.19.7

### Patch Changes

- e28313d: chore(cli): move commander to devDependencies and bundle it
- bcc641e: fix(cli): skipping set config `expo prebuild --platform android`
  - @hot-updater/console@0.19.7
  - @hot-updater/core@0.19.7
  - @hot-updater/aws@0.19.7
  - @hot-updater/cloudflare@0.19.7
  - @hot-updater/firebase@0.19.7
  - @hot-updater/plugin-core@0.19.7
  - @hot-updater/supabase@0.19.7

## 0.19.6

### Patch Changes

- 657a10e: Android Native Build - Gradle Build
- Updated dependencies [657a10e]
  - @hot-updater/aws@0.19.6
  - @hot-updater/cloudflare@0.19.6
  - @hot-updater/firebase@0.19.6
  - @hot-updater/plugin-core@0.19.6
  - @hot-updater/console@0.19.6
  - @hot-updater/supabase@0.19.6
  - @hot-updater/core@0.19.6

## 0.19.5

### Patch Changes

- 40d28c2: bump rnef
- Updated dependencies [40d28c2]
  - @hot-updater/console@0.19.5
  - @hot-updater/core@0.19.5
  - @hot-updater/aws@0.19.5
  - @hot-updater/cloudflare@0.19.5
  - @hot-updater/firebase@0.19.5
  - @hot-updater/plugin-core@0.19.5
  - @hot-updater/supabase@0.19.5

## 0.19.4

### Patch Changes

- Updated dependencies [0ddc955]
  - @hot-updater/plugin-core@0.19.4
  - @hot-updater/console@0.19.4
  - @hot-updater/aws@0.19.4
  - @hot-updater/cloudflare@0.19.4
  - @hot-updater/firebase@0.19.4
  - @hot-updater/supabase@0.19.4
  - @hot-updater/core@0.19.4

## 0.19.3

### Patch Changes

- 0c0ab1d: Add debug option while creating fingerprint
- Updated dependencies [0c0ab1d]
  - @hot-updater/plugin-core@0.19.3
  - @hot-updater/console@0.19.3
  - @hot-updater/aws@0.19.3
  - @hot-updater/cloudflare@0.19.3
  - @hot-updater/firebase@0.19.3
  - @hot-updater/supabase@0.19.3
  - @hot-updater/core@0.19.3

## 0.19.2

### Patch Changes

- 6aa6cd7: fix: globby to fast-glob unicorn-magic error
  - @hot-updater/console@0.19.2
  - @hot-updater/core@0.19.2
  - @hot-updater/aws@0.19.2
  - @hot-updater/cloudflare@0.19.2
  - @hot-updater/firebase@0.19.2
  - @hot-updater/plugin-core@0.19.2
  - @hot-updater/supabase@0.19.2

## 0.19.1

### Patch Changes

- 755b9fe: fix(expo): ensure fingerprint when prebuild
  - @hot-updater/console@0.19.1
  - @hot-updater/core@0.19.1
  - @hot-updater/aws@0.19.1
  - @hot-updater/cloudflare@0.19.1
  - @hot-updater/firebase@0.19.1
  - @hot-updater/plugin-core@0.19.1
  - @hot-updater/supabase@0.19.1

## 0.19.0

### Minor Changes

- c408819: feat(expo): channel supports expo cng
- 886809d: fix(babel): make sure the backend can handle channel changes for a bundle and still receive updates correctly

### Patch Changes

- Updated dependencies [886809d]
- Updated dependencies [fb846ce]
- Updated dependencies [75e82a8]
  - @hot-updater/plugin-core@0.19.0
  - @hot-updater/firebase@0.19.0
  - @hot-updater/console@0.19.0
  - @hot-updater/aws@0.19.0
  - @hot-updater/cloudflare@0.19.0
  - @hot-updater/supabase@0.19.0
  - @hot-updater/core@0.19.0

## 0.18.5

### Patch Changes

- Updated dependencies [494ce31]
  - @hot-updater/plugin-core@0.18.5
  - @hot-updater/cloudflare@0.18.5
  - @hot-updater/console@0.18.5
  - @hot-updater/firebase@0.18.5
  - @hot-updater/supabase@0.18.5
  - @hot-updater/aws@0.18.5
  - @hot-updater/core@0.18.5

## 0.18.4

### Patch Changes

- c6c4838: cancellation of platform selection prompt shows log correctly
  - @hot-updater/console@0.18.4
  - @hot-updater/core@0.18.4
  - @hot-updater/aws@0.18.4
  - @hot-updater/cloudflare@0.18.4
  - @hot-updater/firebase@0.18.4
  - @hot-updater/plugin-core@0.18.4
  - @hot-updater/supabase@0.18.4

## 0.18.3

### Patch Changes

- 34b96c1: fix(native): extracted bundle.zip directly into folder
- d56a2b3: hot-updater doctor
- 72f881c: channel set <channel> after create fingerprint
- 85fc787: fix doctor command check semver version
- 894b2bc: `app-version` shows naive native app version with refactored version utilties
- Updated dependencies [d56a2b3]
  - @hot-updater/aws@0.18.3
  - @hot-updater/console@0.18.3
  - @hot-updater/core@0.18.3
  - @hot-updater/cloudflare@0.18.3
  - @hot-updater/firebase@0.18.3
  - @hot-updater/plugin-core@0.18.3
  - @hot-updater/supabase@0.18.3

## 0.18.2

### Patch Changes

- 70c7f11: fix: no exit deploy in warning state
- Updated dependencies [437c98e]
- Updated dependencies [70c7f11]
  - @hot-updater/plugin-core@0.18.2
  - @hot-updater/cloudflare@0.18.2
  - @hot-updater/console@0.18.2
  - @hot-updater/firebase@0.18.2
  - @hot-updater/supabase@0.18.2
  - @hot-updater/aws@0.18.2
  - @hot-updater/core@0.18.2

## 0.18.1

### Patch Changes

- 8bf8f8f: rspress 2.0.0 and llms.txt
- 7db6246: create fingerprint
- Updated dependencies [8bf8f8f]
  - @hot-updater/console@0.18.1
  - @hot-updater/core@0.18.1
  - @hot-updater/aws@0.18.1
  - @hot-updater/cloudflare@0.18.1
  - @hot-updater/firebase@0.18.1
  - @hot-updater/plugin-core@0.18.1
  - @hot-updater/supabase@0.18.1

## 0.18.0

### Minor Changes

- 73ec434: fingerprint-based update stratgy

### Patch Changes

- Updated dependencies [73ec434]
  - @hot-updater/plugin-core@0.18.0
  - @hot-updater/cloudflare@0.18.0
  - @hot-updater/console@0.18.0
  - @hot-updater/firebase@0.18.0
  - @hot-updater/supabase@0.18.0
  - @hot-updater/core@0.18.0
  - @hot-updater/aws@0.18.0
