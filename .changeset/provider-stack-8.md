---
"@hot-updater/aws": patch
---

Remove duplicate DynamoDB metadata writers and use native atomic commit. Serialize child creation and parent deletion with relationship version guards captured before relation reads.

Reuse each commit attempt's guarded canonical snapshot to maintain metadata projections, avoiding a second strongly consistent read per changed row. Transaction conflicts still reload the snapshot before retrying; canonical and projection writes remain in the same atomic transaction.
