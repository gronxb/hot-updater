---
"@hot-updater/postgres": patch
---

Add publication-bound report page cursors and PostgreSQL section pages.
Prepare long-label ordering in resumable merge steps before publishing, then
read immutable ordinal ranges and sparse counters without rescanning events.

The unreleased report schema now requires ordering tables and indexes. Existing
draft derived storage must be recreated and prepared explicitly; raw events are
preserved. Public runtime replacement and other-provider report engines remain
unfinished.
