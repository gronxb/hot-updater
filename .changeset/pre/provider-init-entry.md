---
"hot-updater": minor
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/supabase": minor
---

Each managed provider package has one `./init` entry, which is the provider's whole init:

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
