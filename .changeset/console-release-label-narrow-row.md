---
"@hot-updater/console": patch
---

fix(console): keep a release's label and ID tail clear of its badges on a phone

On a narrow Bundles card, a labeled release's `v12 · <ID tail>` ran under the "Unreachable" and "Promoted" badges beside it. The badges now move under the ID when the row is too narrow for both, so the label, all 12 characters of the tail, and each badge stay readable and tappable.
