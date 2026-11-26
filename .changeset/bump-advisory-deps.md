---
"@hot-updater/cloudflare": patch
"@hot-updater/aws": patch
"@hot-updater/supabase": patch
"@hot-updater/firebase": patch
"@hot-updater/apple-helper": patch
"@hot-updater/expo": patch
"hot-updater": patch
---

Bump dependencies with open advisories (#2038): `hono` 4.12.34 → 4.13.21, which the Cloudflare Worker bundle and the AWS, Supabase, and Firebase functions ship; `fast-xml-parser` → 5.12.1 in `@hot-updater/apple-helper` and the bundled CLI; and `@babel/core` 7.26.0 → 7.29.13 in `@hot-updater/expo`. A deployed Worker or function keeps its old `hono` until you re-run `npx hot-updater init` after upgrading.
