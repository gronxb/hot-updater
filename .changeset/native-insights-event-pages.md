---
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"@hot-updater/postgres": minor
---

Add an optional native Insights event-page capability and expose it through the
typed server API. PostgreSQL supports cursor pages for global and bundle movement
events with bounded lookahead and index readiness checks, without a total-count
query or the 50,000-event scanner. Existing aggregate and offset APIs retain their
bounded behavior; this is the first stage of the Insights scalability rollout.
