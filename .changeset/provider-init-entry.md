---
"hot-updater": minor
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/supabase": minor
---

Each managed provider package has one `./init` entry, which is the provider's whole init:

- `initProvider`: the inputs init asks for and checks, and the server definitions it writes;
- `runInit`.

`./iac` is removed.

`hot-updater init` bundles no provider code. It installs the chosen provider package, imports that package's `./init`, checks the provider's inputs, and then runs `runInit`:

- **`--from-env-file`** reports problems in two stages:
  - a missing build adapter or provider, before init installs packages;
  - every missing provider input, once init has installed the provider package and before it creates or changes any resource.
- **Switching providers.** Init replaces another provider's unedited server definition only while that provider's package is still installed, as it is right after a switch. Otherwise init refuses the definition, as before, because of what it imports.
- **`hot-updater init --help` and `hot-updater infra scaffold`** don't need any provider package installed. They read each provider's inputs from the infrastructure templates, which the CLI's build records.
