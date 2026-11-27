---
"@hot-updater/console": patch
---

The Bundles table shows a release's label and its ID in their own columns, Label then ID, so `v14` no longer reads as part of the ID. The ID column shows the ID's last 12 characters, a UUID's last group, for every release, labeled or not, followed by the row's badges: hovering or focusing it shows the full ID, and a click copies it. A release without a label yet shows a dash in the Label column that still opens it. The Bundle detail sheet gives the label and the ID their own rows the same way. Phone cards, Insights, and the other screens keep `v14 <ID tail>`.
