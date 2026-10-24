---
"@hot-updater/aws": patch
---

AWS `hot-updater init` no longer fails with `ContinuousBackupsUnavailableException` right after it creates the DynamoDB table. A new table can be ACTIVE before it accepts point-in-time recovery, so init now retries turning it on every 5 seconds for up to 2 minutes, and reports that init can be rerun if the table still refuses. Any other AWS error still stops init at once.
