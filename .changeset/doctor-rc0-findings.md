---
"hot-updater": patch
---

Fixes from the 1.2.0-rc.0 QA of `hot-updater doctor` and the CLI.

- Without `--server-base-url`, doctor checks the server an agent infrastructure scaffold records in `hot-updater-infra/<provider>/*/deployment.json`, naming the file in `details.infrastructure.recordedIn`. When none records one, or several record different servers, it reports `details.infrastructureUnchecked`: the server's version was not checked, and `npx hot-updater doctor --server-base-url <url>` checks it. It no longer reports success with nothing about the skip.
- Init's command names `--from-env-file .env.hotupdater` only when that file holds the init record and every input doctor compared, as doctor read them. When they came from the environment, such as CI's variables or a file the config loads, the command names `--build` and `--from-env-file <env file>` and says that init needs them too.
- For a deployment an agent infrastructure scaffold in `hot-updater-infra/<provider>/` keeps, doctor names `npx hot-updater agent infra upgrade --provider <provider> --build <build>` and its upload, preview, migrate and deploy order instead of init, which would deploy without a preview and leave the scaffold behind.
- When the console's port is taken, `hot-updater console` says that `console.port` in hot-updater.config.ts changes it.
- The upgrade files the agent infrastructure scaffold copies, such as `upgrades/1.2.0.md`, are oxfmt-formatted as shipped, so a project's formatter keeps them as generated and their manifest hashes hold.
