---
"@hot-updater/console": patch
---

The console shows only the features whose plugins the server runs.

- **Navigation:** Insights appears when the server runs `insights()`, and API keys when it runs `apiKeys()`. A feature's page opened without its plugin names the plugin to add and links to the console deployment guide.
- **Bundles:** the list's Insights column and the bundle detail's Insights card appear only where the console reads release activity, instead of a "—" or a note.
- **`standaloneRepository`:** the console reads the server's plugins once, from its admin `/version`, instead of asking the Insights events route. When the server runs `insights()`, Insights opens on All events with its events and installations; usage, bundle activity, and API keys need the database config. A server on an older `@hot-updater/server` lists no plugins on `/version`, so its console shows neither Insights nor API keys until the server is upgraded.
- **Server functions:** every Insights and API key server function checks its feature first, and refuses one the console does not serve with the same not-found error.
