---
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"@hot-updater/plugin-api-keys": minor
"hot-updater": minor
"@hot-updater/cli-tools": minor
---

Plugins no longer add `hot-updater` commands. `PluginCli` keeps `clientCredential` and `clientPlugin`, the metadata that `hot-updater init`, `hot-updater doctor`, and the agent scaffold read, and its `commands` is removed, with no replacement:

- These names are removed from every package: `PluginCommand`, `PluginCommandArgument`, `PluginCommandOption`, `PluginCommandContext`, `PluginCommandUi`, and `PluginTableColumn`, which rc.20 exported from `@hot-updater/server/plugins`, and `pluginCommandsOf` and `PluginCommandEntry`, which rc.20 exported from `@hot-updater/server/db`.
- `createHotUpdater` refuses a plugin whose `cli` holds `commands`, or any key other than `clientCredential` and `clientPlugin`, with `HotUpdaterConfigError`.
- The CLI no longer looks for plugin commands, and `hot-updater --help` no longer lists **Plugin commands**.

`hot-updater api-key create|list|revoke` is a built-in command again: `create --name <name>`, `list` with `--json`, and `revoke <id>` with `-y`, each with an optional trailing `[serverPath]`. It manages keys through `apiKeys()` over the first of:

- the server file `serverPath` names, such as `src/hotUpdater.ts` in a server project;
- `database` and `plugins` in `hot-updater.config.ts`, when the config sets `database`;
- `src/hotUpdater.*` or `src/db.*`.

When those plugins lack `apiKeys()`, it says to add it. With `database: standaloneRepository(...)`, it says to run the command in the server project with the server file's path, since the admin API serves no API key routes. The `cli` of `apiKeys()` from `@hot-updater/plugin-api-keys` holds only its `clientCredential`.
