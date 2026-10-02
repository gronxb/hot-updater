---
"hot-updater": minor
---

`hot-updater doctor` warns `MISSING_CLIENT_PLUGIN` when a server plugin's client plugin is missing from the app: for each client plugin that the plugins in `hot-updater.config.ts` name and no app source imports, it says to import it and pass it to `HotUpdater.init({ plugins })`. It checks a project that installs `@hot-updater/react-native` and sets `database`, and warns `CLIENT_PLUGINS_UNCHECKED` when it cannot load the config's database and plugins.
