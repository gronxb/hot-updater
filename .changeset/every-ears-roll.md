---
"@hot-updater/plugin-insights": patch
"@hot-updater/console": patch
---

Collect the original update error message and stack trace in Insights and display them in Console event history. Preserve distinct error messages when deduplicating daily failures, and identify older reports with no recorded cause. Error text is bounded to fit the event payload. Existing database schemas remain compatible.
