---
"@hot-updater/plugin-core": patch
"@hot-updater/cli-tools": patch
---

Upload non-archive files with `application/octet-stream` instead of `application/zip`. `getContentType` fell through to the compression format table for any name `mime` did not resolve, and that table defaults to zip, so brotli bundle assets (`.br`), extensionless content addressed assets, and `.bsdiff` patches were all mislabeled by the CLI storage upload helper.
