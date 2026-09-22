---
"@hot-updater/aws": patch
"hot-updater": patch
---

Replace DynamoDB metadata table scans with keyed projections and targeted atomic commits. Existing tables require the explicit metadata-index backfill with writers stopped; missing projections fail explicitly at runtime. Keep rollout requirements in the unreleased 1.0.0 baseline.
