---
"@hot-updater/console": minor
"@hot-updater/server": minor
---

Add a View all events entry point in Insights to browse event history without
an installation search, reporting-period filter, or bundle filter. Include all
event types in newest-first order, with pagination, refresh, and links to
installation history. Keep the existing Insights scan limit and report an
error rather than silently returning partial history when it is exceeded.
