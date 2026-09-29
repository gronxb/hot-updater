---
"@hot-updater/server": minor
"@hot-updater/plugin-core": patch
---

Fit the storage engine's schema to MySQL's index limit.

- **ASCII strings:** a string field can be declared `ascii`, and MySQL stores it in a single-byte `ascii_bin` column. Catalog scope keys, channel keys, and auto-patch candidate keys use it. Candidate keys escape any non-ASCII character in a channel id.
- **Key size check:** DDL refuses a MySQL key or index over 3,072 bytes before any statement runs.
