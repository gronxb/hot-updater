---
"@hot-updater/console": minor
---

`defineConsoleConfig({ server, gitUrl })` takes the server the console manages: your server definition, the `hotUpdater` that `createHotUpdater` returns, or `standaloneRepository(...)`, which reaches a self-hosted server through its admin API. The console reads the database, storage, and plugins from the definition, or the plugins a self-hosted server lists on its admin `/version`, and shows only the built-in features of the plugins the server runs. It reads and deletes each bundle file with the storage of its protocol. The Vite plugin reads `console.config.ts` by default, and `hot-updater console` follows `server` in `hot-updater.config.ts`.
