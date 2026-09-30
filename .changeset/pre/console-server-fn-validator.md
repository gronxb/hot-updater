---
"@hot-updater/console": patch
---

Validate server function input with `validator()` instead of the deprecated `inputValidator()`, so building the console no longer prints a deprecation warning for each function. `@tanstack/react-start` now needs 1.168.25 or later, the first release with `validator()`.
