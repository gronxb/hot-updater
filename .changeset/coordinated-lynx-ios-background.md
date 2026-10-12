---
"@hot-updater/lynx": patch
---

Coordinate iOS foreground ownership with detached background script snapshots.
Preserve pending updates during cold snapshot selection, reserve recovery capacity
for concurrent tasks, and persist fatal results against their native receipts
without replacing unrelated foreground state. Retain failed writes for replay,
and reject writes from retired controllers.
