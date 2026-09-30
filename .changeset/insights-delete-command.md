---
"@hot-updater/server": minor
---

`insights()` adds `hot-updater insights delete --install-id <id>` and `--user-id <id>` through its `cli` commands. The command deletes one installation's Insights data, or that of every installation whose latest event names the user, repeating the bounded deletion until it completes; `-y` skips the confirmation and `--json` prints the counts. Over a direct database it runs through the plugin's API, and with `standaloneRepository` through the admin `DELETE /installations` routes, which needs `hotUpdater.plugins.ts` to list `insights()`.
