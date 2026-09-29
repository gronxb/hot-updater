---
"@hot-updater/server": patch
---

Rerun a transaction whose gauge would go below zero instead of failing it. Another writer can move a gauge after a transaction reads the row that decides its deltas. That transaction's guard on the row fails anyway, so the engine now reads both again. The error is thrown only when a gauge stays negative through every attempt.
