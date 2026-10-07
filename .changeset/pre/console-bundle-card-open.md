---
"@hot-updater/console": patch
---

Console fixes for reading bundles and their health at a glance:

- On narrow screens, where the Bundles list shows a card per bundle, tapping anywhere on a card opens its Bundle Detail, as clicking a row does in the wide table. The card's own controls keep their actions.
- Release health opens on **24h**. A bundle row's Insights summary opens it over the shortest period that covers the release's deployment, as **View adoption** does: 24h within a day of it, 7d within a week, else 30d.
- The bundle a native build shipped is labeled **Built-in bundle** everywhere (it was "Built-in app"). Event and installation details mark it from an SDK that reports no `minBundleId` too, by its ID: the build time with the random bits zeroed, which no deployed bundle's ID has.
- **Update failures** shows each kind of failure as one rate, then its failures and the installations behind them, in place of six separate numbers. The change from the previous period appears once a whole previous period was recorded, patch fallbacks appear only when a download tried a patch, and a failure with no reason reads **No reason reported**, with a note when those are most of them. Errors to investigate show the placeholder for a missing error message in muted text.
