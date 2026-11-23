---
"@hot-updater/console": patch
---

fix(console): name a labeled release `v12 · <ID tail>` instead of its label beside the full ID

A labeled release now shows its label, then the last 12 characters of its ID, in the Bundles table, the bundle detail sheet, the Insights release pickers and charts, and the native build's Served now card. Hovering shows the full ID, and screen readers and copy still get `v12 <full ID>`. A release without a label still shows its full ID.
