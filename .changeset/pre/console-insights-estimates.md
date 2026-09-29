---
"@hot-updater/console": patch
---

Insights shows unique counts as estimates and reads one period end. DAU, WAU, MAU, the active users per interval, and a release's unique users come from HyperLogLog sketches, so they show as "≈ 1,234" with an Estimated label for hover and screen readers; zero stays exact. App usage and release health now end with the current UTC hour, as the reporting overview does, so a report counts as soon as the server records it instead of after the hour ends.
