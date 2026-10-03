---
"@hot-updater/plugin-insights": patch
"@hot-updater/console": patch
---

Collect the original update error message and stack trace in Insights and display them in Console event history. Preserve distinct error messages when deduplicating daily failures, and identify older reports with no recorded cause. Error text is bounded to fit the event payload. Console now compares failure rates with the previous period and groups loaded error reports by their original message, with occurrence-specific stacks, app and SDK versions, installation history, and copyable reports. Raw history loads in bounded, resumable batches with explicit coverage. Existing database schemas remain compatible.
