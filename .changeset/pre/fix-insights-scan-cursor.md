---
"@hot-updater/plugin-core": patch
---

Apply Insights scan cursors in database queries instead of re-reading the
entire preceding history for each page. Preserve timestamp ties and the
exclusive cutoff while returning at most the requested number of rows.
This reduces repeated reads; the server's 50,000-event aggregation limit is
unchanged.
