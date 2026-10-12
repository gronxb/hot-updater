---
"@hot-updater/lynx": patch
---

Allow one later-process retry of an interrupted primary Release after the fallback
confirms native readiness. Preserve the hold across managed runtime recreation,
permanently exclude a second unfinished attempt, and keep fatal and secondary-page
failures separate from unexplained exits.
