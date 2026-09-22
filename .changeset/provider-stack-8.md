---
"@hot-updater/aws": patch
---

Remove duplicate DynamoDB metadata writers and use native atomic commit. Serialize child creation and parent deletion with relationship version guards captured before relation reads.
