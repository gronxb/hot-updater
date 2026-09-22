---
"@hot-updater/aws": patch
"hot-updater": patch
---

Replace DynamoDB metadata table scans with keyed projections and targeted atomic commits. Existing tables require the explicit metadata-index backfill with writers stopped; missing projections fail explicitly at runtime. Keep rollout requirements in the unreleased 1.0.0 baseline.

Permit the existing metadata projection namespace in generated Lambda IAM policies; refresh deployed roles alongside the 1.0.0 backfill. Bound finite bundle-ID cursor pages before hydration and skip unchanged projection writes. Compound release filters still use residual filtering within a keyed partition; this cleanup does not guarantee constant evaluated-entry cost for every filter combination.
