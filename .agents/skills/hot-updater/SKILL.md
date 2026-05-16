---
name: hot-updater
description: Use when working with Hot Updater CLI setup, deployment, patch artifacts, bundle inventory/state, rollback, channels, code signing keys, database migration, diagnostics, or AI-assisted React Native OTA operations.
metadata:
  author: hot-updater
  version: "1.0.0"
---

# Hot Updater CLI

Use this skill when a task involves Hot Updater's CLI, `hot-updater.config.ts`,
React Native OTA deployment, patch artifacts, bundle operations, rollback,
release-channel management, code signing keys, database migration, fingerprints,
or diagnostics.

## Operating Rules

- Start from the project root unless the user specifies another app directory.
- Read local `hot-updater.config.ts` before assuming provider behavior.
- Use `npx hot-updater ...` for CLI examples and user-facing instructions.
- Do not run `npx hot-updater init` on behalf of the user. It is interactive
  and asks for provider, build, and project-specific choices. Guide the user to
  run it directly and follow the setup documentation.
- Before running `npx hot-updater doctor` for a server/infrastructure check,
  make sure the server base URL is available. If the user did not provide it
  and it is not obvious from local config, ask for the update server URL first.
- For doctor repair loops, run `npx hot-updater doctor --json` first. Fix
  issues marked `fixability: "auto"` by editing local project files, run the
  listed `commands` for issues marked `fixability: "command"`, and rerun doctor
  after each focused change. Stop when doctor passes or the remaining issues are
  marked `fixability: "blocked"`.
- Treat `fixability: "blocked"` as outside the autonomous local loop. Server
  infrastructure remediation commonly needs provider credentials, environment
  variables, and redeploy access; summarize the blocker instead of running
  migrations or mutating provider setup.
- Treat `deploy`, `patch`, `bundle enable`, `bundle disable`, `bundle update`,
  `bundle delete`, `bundle promote`, `rollback`, `channel set`, `keys
  export-public`, `keys remove`, and `db migrate` as state-changing operations.
- Treat `keys generate` and `db generate` as local file/artifact writing
  operations.
- Use `--json` only with commands documented here as supporting it. For
  mutating commands, `--json` only changes the output format after the requested
  mutation has already been authorized. If a target project uses an older CLI
  without that option, fall back to the human-readable output.
- For non-interactive shells, use `-y` only when the user already requested the
  exact mutation and the target is unambiguous.
- After mutating bundle state, verify with `bundle list` or the relevant
  provider state.
- If `deploy` fails, stop the deploy workflow. Do not keep retrying fixes,
  edit setup, change credentials, install dependencies, or run migrations
  unless the user explicitly asks for that follow-up. Analyze only the failed
  command, relevant output, likely cause, and suggested next checks.
- Do not edit provider credentials unless the user explicitly asks. Credentials
  are commonly stored in `.env.hotupdater`, but projects may use a different
  environment-loading setup.

## Natural Language Requests

Users may invoke this skill with prompts such as:

```txt
$hot-updater deploy using the current app version
$hot-updater deploy the current iOS app version to production
$hot-updater roll back the most recently deployed bundle
$hot-updater list iOS bundles on the production channel
$hot-updater update rollout cohort count for bundle <bundle-id> to 500
$hot-updater promote bundle <bundle-id> to staging
$hot-updater create a patch from bundle <old-id> to <new-id>
$hot-updater export the code signing public key
$hot-updater run doctor with server URL https://updates.example.com/api/check-update
$hot-updater fix local doctor issues that do not require server credentials
```

Translate the request into the safest CLI flow. If a state-changing request is
missing a required channel, platform, bundle target, patch base, destination
channel, or server URL that cannot be inferred from local context, ask one
concise question before mutating anything. For deploy and patch channel, use the
CLI default `production` unless the user names another channel or local context
clearly indicates one.

### Current App Version Deploy

When the user asks to deploy for the current app version:

1. Run `npx hot-updater app-version --json` when supported; otherwise run
   `npx hot-updater app-version`.
2. Extract `ios` and/or `android` from JSON when available, or from the
   human-readable output as a fallback.
3. If the platform is missing, ask whether to deploy iOS, Android, or both.
4. Deploy with `-t <version>`:

```sh
npx hot-updater deploy -p ios -t <ios-app-version>
npx hot-updater deploy -p android -t <android-app-version>
```

If deploying both platforms, run one platform at a time and verify each result
with `npx hot-updater bundle list -p <platform> --limit 5 --json` when
supported, or without `--json` as a fallback.

If a deploy command fails, do not continue to the next platform or attempt an
automatic repair. Report the failure analysis and wait for a new user request.

### Recent Bundle Rollback

When the user asks to roll back the most recent deployment without naming a
bundle:

1. Run `npx hot-updater bundle list --json --limit 10`.
2. Choose the most recent enabled bundle from the JSON result.
3. Use that bundle's `channel`, `platform`, and `id` for a scoped rollback:

```sh
npx hot-updater rollback <channel> -p <platform> --target <bundle-id> -y
```

If the most recent bundle is already disabled, tell the user and ask whether to
roll back the next enabled bundle. After rollback, verify with:

```sh
npx hot-updater bundle list -c <channel> -p <platform> --limit 5 --json
```

If `--json` is unavailable, rerun the same command without `--json`.

## Core Commands

### Setup and Diagnostics

```sh
npx hot-updater init
npx hot-updater doctor --server-base-url <update-server-url>
npx hot-updater doctor --json
npx hot-updater doctor --server-base-url <update-server-url> --json
npx hot-updater fingerprint
npx hot-updater fingerprint create
npx hot-updater app-version
npx hot-updater app-version --json
npx hot-updater console
```

- `init` creates or updates project configuration. Because it is interactive,
  tell the user to run it directly instead of choosing answers for them.
- `doctor` checks local setup and server health. Provide `--server-base-url`;
  the command appends `/version` for the server check. If the user has not
  provided one, ask for it before running the command.
- `doctor --json` is the preferred agent surface. It returns stable issue
  codes, related paths, `fixability`, and command hints for local iterative
  repair. Do not parse the human-readable doctor output when JSON is available.
- `fingerprint` and `fingerprint create` generate the app fingerprint.
- `app-version` reads native iOS and Android app versions. `--json` returns
  `{ "android": string | null, "ios": string | null }` on CLIs that support it.
- `console` opens the local management console.

### Deploy

```sh
npx hot-updater deploy -p <ios|android>
npx hot-updater deploy -p ios -c production -r 25
npx hot-updater deploy -p android -f
npx hot-updater deploy -p ios -d
npx hot-updater deploy -p ios -o ./hot-updater-output
```

Important options:

| Option | Meaning |
| --- | --- |
| `-p, --platform <platform>` | Target `ios` or `android`. |
| `-c, --channel <channel>` | Release channel, default `production`. |
| `-t, --target-app-version <range>` | App version range such as `1.2.3` or `1.x.x`. |
| `-r, --rollout <percentage>` | Initial rollout percentage from `0` to `100`. |
| `-f, --force-update` | Apply immediately on client update. |
| `-d, --disabled` | Upload disabled for later enablement. |
| `-o, --bundle-output-path <path>` | Directory where bundle archives are generated. |
| `-m, --message <message>` | Custom deployment message. |
| `-i, --interactive` | Guided deployment flow. |

### Patch Artifacts

```sh
npx hot-updater patch -b <bundle-id> --base-bundle-id <base-bundle-id> -p ios
npx hot-updater patch -b <bundle-id> --base-bundle-id <base-bundle-id> -p android -c production
npx hot-updater patch -i
```

Important options:

| Option | Meaning |
| --- | --- |
| `-b, --bundle-id <bundleId>` | Target bundle id that should receive the patch artifact. |
| `--base-bundle-id <baseBundleId>` | Older bundle id to use as the patch base. |
| `-p, --platform <platform>` | Target `ios` or `android`. |
| `-c, --channel <channel>` | Channel used to load config, default `production`. |
| `-i, --interactive` | Guided patch flow. |

### Bundle Inventory and State

```sh
npx hot-updater bundle list
npx hot-updater bundle list -c production -p ios --limit 10
npx hot-updater bundle list -c production -p ios --limit 10 --json
npx hot-updater bundle list --json
npx hot-updater bundle show <bundle-id>
npx hot-updater bundle show <bundle-id> --json
npx hot-updater bundle disable <bundle-id>
npx hot-updater bundle enable <bundle-id>
npx hot-updater bundle update <bundle-id> --rollout-cohort-count 500
npx hot-updater bundle update <bundle-id> --force-update true --json
npx hot-updater bundle update <bundle-id> --target-cohorts 1,2,3
npx hot-updater bundle update <bundle-id> --clear-target-cohorts
npx hot-updater bundle delete <bundle-id>
npx hot-updater bundle promote <bundle-id> -t staging
npx hot-updater bundle promote <bundle-id> -t staging -a move
```

- `bundle list` shows the most recent bundles first.
- `bundle list --limit <n>` defaults to `20`.
- `--json` is available for `bundle list`, `bundle show`, and `bundle update`
  on CLIs that support it.
- `bundle disable` and `bundle enable` read the bundle, mutate enabled state,
  commit the change, then re-read to verify.
- `bundle update` can set rollout cohort count from `0` to `1000`, force update
  metadata, and target cohorts.
- `bundle delete` removes the bundle record by id.
- `bundle promote` copies to a target channel by default. Use `-a move` only
  when the user explicitly wants to keep the same bundle id and move channels.
- In CI or other non-interactive shells, pass `-y` to `enable` or `disable`.
  Also pass `-y` to `update`, `delete`, or `promote` only when the requested
  mutation target is unambiguous.

### Rollback

```sh
npx hot-updater rollback <channel>
npx hot-updater rollback production -p ios
npx hot-updater rollback production -p ios --target <bundle-id> -y
```

- Rollback disables the latest enabled bundle on the channel.
- Without `-p`, rollback applies to both iOS and Android.
- The next most recent enabled bundle on the same channel and platform becomes
  the fallback.
- If no previous enabled bundle exists, the app falls back to the JavaScript
  bundle shipped in the native binary.
- Use `--target <bundle-id>` to retry a partial rollback for exactly one bundle.

### Channels

```sh
npx hot-updater channel set <channel>
```

This writes the default channel into native iOS and Android project files.
Changing this embedded channel requires a native rebuild.

### Code Signing Keys

```sh
npx hot-updater keys generate
npx hot-updater keys generate -o ./keys -k 4096
npx hot-updater keys export-public
npx hot-updater keys export-public -i ./keys/private.pem --print-only
npx hot-updater keys remove
```

- `keys generate` writes an RSA key pair. The default output directory is
  `./keys`, and supported key sizes are `2048` and `4096` with default `4096`.
- `keys export-public` reads the private key from `-i` or from
  `signing.privateKeyPath` in `hot-updater.config.ts`, then writes native public
  key configuration unless `--print-only` is used.
- `keys remove` removes public keys from native configuration files.
- Use `-y` for native file writes only when the user explicitly requested the
  exact operation.

### Database

```sh
npx hot-updater db generate [configPath] [outputDir]
npx hot-updater db generate --sql
npx hot-updater db generate --sql postgresql
npx hot-updater db migrate [configPath]
```

- `db generate` creates migration output without applying it. The default
  output directory is `hot-updater_migrations`.
- `db generate --sql [provider]` creates a standalone SQL file without reading
  config. Supported providers are `postgresql`, `mysql`, and `sqlite`; omitting
  the provider starts interactive selection.
- `db migrate` applies the latest migration through the configured database
  plugin.
- Pass `-y` only when the user explicitly requested the write or migration.
