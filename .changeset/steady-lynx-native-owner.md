---
"@hot-updater/lynx": patch
"@hot-updater/lynx-sparkling": patch
---

Coordinate Android foreground ownership and verified background script snapshots
within the same native scope. Read cold selections without consuming staged or
pending foreground state, reject snapshots from failed live generations, and
release scope ownership when a controller closes. This adds native selection
primitives; OS background task delivery and execution remain separate work.
