---
"hot-updater": patch
"@hot-updater/supabase": patch
---

Harden Supabase init by enabling RLS for Hot Updater tables, pinning
Supabase function search paths, and generating service-role env naming while
failing skipped legacy configs before writing the service-role env key.
