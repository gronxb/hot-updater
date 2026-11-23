---
"@hot-updater/console": patch
---

fix(console): keep a release's label and ID tail clear of the badges beside it on a phone

On a narrow screen, a labeled release's `v12 · <ID tail>` ran under the badge next to it: "Promoted" and "Unreachable" on a Bundles card, and "Disabled" in the Insights bundle table. Those badges now move under the label when the row has no room for both, so the label, all 12 characters of the tail, and each badge stay readable and tappable.
