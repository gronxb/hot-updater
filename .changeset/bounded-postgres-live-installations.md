---
"@hot-updater/postgres": patch
---

Add an internal PostgreSQL latest-installation projection with bounded binary
cursor pages and explicit readiness checks. Direct and mixed event writes now
commit the source allocation, raw row and latest installation atomically.

Deployments must complete the committed-source preparation, drain old writers,
apply the live-installation migration and deploy the upgraded writer together.
The new old-writer fence rejects omitted live markers. Legacy projection rows are
prepared through bounded maintenance steps; no startup scan or offset fallback is
added.
