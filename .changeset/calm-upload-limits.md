---
"hot-updater": patch
---

Limit manifest asset upload concurrency during deploy to prevent Supabase Storage uploads from exhausting database connections when many manifest assets are published, and report upload progress through 100%.
