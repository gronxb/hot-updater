---
"@hot-updater/console": patch
---

fix(console): name a labeled release `v12 · <ID tail>` instead of its label beside the full ID

A labeled release now shows its label, then the last 12 characters of its ID, in the Bundles table, the bundle detail sheet, the Insights release picker, release lists, crash alert, rollback dialog, and chart tooltip, and the native build's Served now card. The whole ID stays in the text, clipped to its tail: hovering shows it, screen readers read it, and selecting the whole ID copies all of it. A release without a label still shows its full ID.
