---
"@hot-updater/plugin-core": patch
"@hot-updater/postgres": patch
---

Add shared finite report projections and PostgreSQL durable job accumulation.
Reserve reusable requests, capture one committed source, and commit bounded
derived writes with fenced checkpoints and immutable summary publications.
Expose explicit report schema/worker tooling through the PostgreSQL DB entry.

The runtime query replacement, section pagination and other-provider report
engines are not enabled by this internal preparation step.
