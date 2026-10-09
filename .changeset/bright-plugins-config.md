---
"hot-updater": minor
"@hot-updater/cli-tools": patch
"@hot-updater/aws": patch
"@hot-updater/cloudflare": patch
"@hot-updater/firebase": patch
"@hot-updater/supabase": patch
---

Export official plugin factories from `hot-updater/plugins` and generate explicit plugin arrays in managed configs, matching the server and client configuration pattern.

Migrate server plugin imports when rerunning init, preserve legacy plugin files still needed by existing configs, and propagate Firebase config write failures. Report config shapes that could override the generated plugin list instead of claiming a successful merge.
