---
"@hot-updater/console": minor
---

`defineConsoleConfig({ database, storage, plugins, console: { gitUrl } })` keeps rc.20's shape, except that `console` takes only `gitUrl`. `console.port` is gone from `console.config.ts`: the console never read it, and its host sets the port. `hot-updater console` still reads `console.port` in `hot-updater.config.ts`. List the server plugins your server runs in `plugins`, such as the `plugins` a managed provider package exports or `[insights(), apiKeys()]`: the console shows only the built-in features of the plugins listed.

- The console runs `createHotUpdater` over `database`, `storage`, and `plugins`, as the server does, and writes through its core: a listed plugin whose migration has not run stops a request with an error that names the fix, and writes on SQL databases delete the plugins' expired rows.
- With `database: standaloneRepository(...)`, the console takes the features it shows from `plugins` instead of the server's admin `/version`, and reads Insights through the admin API.
- The hosted console's Vite plugin reads `console.config.ts` by default, in place of `hot-updater.config.ts`. `hot-updater console` reads the database, storage, and plugins in `hot-updater.config.ts`.
