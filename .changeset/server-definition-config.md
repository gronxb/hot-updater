---
"hot-updater": minor
"@hot-updater/cli-tools": minor
"@hot-updater/plugin-core": minor
"@hot-updater/standalone": minor
---

`hot-updater.config.ts` holds deploy settings and points at the server with `server`, so the database, storage, and plugins are configured once, in the server definition:

```ts
// src/hotUpdater.ts
export const hotUpdater = createHotUpdater({ database, storage: [s3Storage(...)], plugins: [insights()] });

// hot-updater.config.ts
export default defineConfig({ server: "./src/hotUpdater.ts", build: bare(), updateStrategy: "appVersion" });
```

- `server` is a path, relative to the config file, to the module that exports `hotUpdater`. The CLI loads it only for commands that need the server: deploy, patch, the `bundle` commands, `db`, `storage prune`, `console`, plugin commands, and doctor's client plugin check. `fingerprint`, `channel`, `keys`, and native builds never load it. The module's optional `closeDatabase` export closes what it opened.
- The CLI uploads bundles to the definition's first storage; each storage reads the URIs of its protocol.
- For a self-hosted server the CLI reaches through its admin API, `server` is `standaloneRepository({ baseUrl, commonHeaders, storage })`. `storage` is where the CLI uploads bundles, and the server lists its own plugins on its admin `/version`.
- `database`, `storage`, and `plugins` in `hot-updater.config.ts` are refused with a message that names `server`, and `hotUpdater.plugins.ts` is no longer read.
- `hot-updater db migrate` and `db generate` default to the definition `server` points at; plugin commands find their plugins there too, or in a definition the command line names.
- In `@hot-updater/plugin-core`, `RemoteServer` (with `url` and `storage`) and `isRemoteServer` replace `RemoteDatabase` and `isRemoteDatabase`, and `ConfigInput` has `server` in place of `database` and `storage`.
- `@hot-updater/cli-tools` adds `importServerModule`, which loads a server definition as the CLI and the console do, and renders a server definition beside the config for init.
- The agent infrastructure scaffold ships `app/hotUpdater.ts`, the server definition, in place of `app/database.config.ts` and `app/hotUpdater.plugins.ts`; its credential script reads the database and plugins there.
