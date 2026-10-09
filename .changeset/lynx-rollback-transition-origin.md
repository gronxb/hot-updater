---
"@hot-updater/lynx": patch
---

Preserve the previous confirmed Release as Android rollback transition history
when a newer catalog disables it. Keep execution eligibility checks unchanged.
Preserve recovery origins and transition IDs across controller recreation on
both platforms while the complete recovery target remains selected.
