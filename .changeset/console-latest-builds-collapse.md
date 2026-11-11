---
"@hot-updater/console": minor
---

Native builds lead with the newest build of each distribution path (platform, channel, sandbox, and TestFlight, a Play track, or the artifact): a page's older builds collapse into one "N older builds" group, shaded and labelled "Older" with the newer build named when it opens. Bundles collapse a page's unreachable bundles the same way. Each list keeps the open group in its URL (`showOlder`, `showUnreachable`) and reads nothing to open it; the Disabled and artifact filters, and a selected bundle, still show their bundles in place.
