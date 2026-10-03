---
"@hot-updater/console": patch
---

The All events list reads one time range, newest first: the last 24 hours, 7 days (the default), 30 days, or 90 days, ending when the list loads or the range changes. Changing the range returns to the first page, and the URL keeps it. Pages stop at the range start: a range without events, and its last page, say so and offer the next longer range. An empty page after a full one says there are no older events, in All events and in installation history.
