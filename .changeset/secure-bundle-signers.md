---
"@hot-updater/aws": patch
"@hot-updater/cli-tools": patch
"@hot-updater/cloudflare": patch
"@hot-updater/console": patch
"@hot-updater/expo": patch
"@hot-updater/firebase": patch
"@hot-updater/plugin-core": patch
"@hot-updater/supabase": patch
"hot-updater": patch
---

Add plugin-based Bundle Signing with local PEM, AWS KMS, Google Cloud
KMS-backed Firebase, Cloudflare Workers, and Supabase Edge Functions, require a
pinned public key for native and Expo builds, and expose only sanitized signing
status in Console.
