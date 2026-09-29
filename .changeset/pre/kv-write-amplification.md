---
"@hot-updater/server": patch
---

An Insights event writes one fewer index entry on every backend. `bundle_events.bundle_ref` now holds only the ref a bundle filter reads: `from:<bundle>` for `RECOVERED`, and `to:<bundle>` for the other types, so a movement event writes one `byBundle` entry instead of two. Events recorded before keep both refs, and no filter reads the extra one.
