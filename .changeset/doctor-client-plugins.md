---
"hot-updater": minor
---

`hot-updater doctor` warns when a server plugin's client plugin is missing from the app: for each client plugin the server's plugins name (from the server definition, or a self-hosted server's admin `/version`) that no app source imports, it says to import it and pass it to `HotUpdater.init({ plugins })`.
