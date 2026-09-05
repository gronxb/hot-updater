---
"@hot-updater/console": minor
"@hot-updater/server": minor
---

Add Overview / Events navigation in Insights to browse event history without
an installation search or bundle filter. Include all event types in newest-first
order with cursor pagination, refresh, and links to installation history that
preserve the source page and scroll position. Use readable local timestamps,
copyable short identifiers, semantic event labels, and responsive mobile cards.
Replace raw-event aggregation with a compact latest-installation projection so
reporting-installation counts and exact identity lookup do not depend on a
50,000-event application scan.
