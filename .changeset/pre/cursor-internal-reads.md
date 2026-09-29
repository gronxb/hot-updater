---
"@hot-updater/plugin-core": patch
"@hot-updater/supabase": patch
---

Continue internal multi-page reads from the last unique key instead of an offset. Patch hydration and channel listing page by patch id and channel name, and Supabase's latest-installation reads page by install id and event id when PostgREST caps a response. Each page starts after the last row already read, so no row is scanned twice. Results and ordering are unchanged.
