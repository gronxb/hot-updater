---
"@hot-updater/server": patch
---

Keep non-null event timestamp and ID ordering directly usable by the Kysely
and Drizzle SQL indexes without changing nullable-field sorting.

Prepare an internal MongoDB event-page reader using strict index readiness,
simple collation, index hints and bounded native ranges. Public provider wiring
still requires the separate historical-data audit and writer guards.
