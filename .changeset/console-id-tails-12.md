---
"@hot-updater/console": patch
---

Every release and artifact ID in the Console now shows as its last 12 characters, the way the Bundles table's ID column does: `v14 <ID tail>` on phone cards, Insights, Served now, pickers, and chart tooltips, and the tail alone for a release without a label, which no longer shows its full ID. Artifact IDs (the "Patch artifacts from this base" panel, the Built-in bundle card, a native build's patches, the release sheet's diagnostics) and the bundles in Insights' event and installation history use the same tail: hovering or focusing it shows the full ID, and a click copies it; an artifact's popover says it is an artifact ID. The Bundles table gives the expand chevron a column of its own, so the Label and ID headers sit over their values and an unreachable-bundles fold lines up with the rows.
