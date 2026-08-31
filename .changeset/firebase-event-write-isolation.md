---
"@hot-updater/firebase": patch
---

Stop reading event history when appending an Insights event or reading and
mutating the release catalog. Create event documents directly, and keep event
inserts in mixed commits atomic with the other changes. Duplicate event IDs fail
without replacing existing events or partially applying a commit.
