---
"@hot-updater/plugin-core": patch
"@hot-updater/aws": patch
"@hot-updater/cloudflare": patch
"@hot-updater/firebase": patch
"@hot-updater/supabase": patch
---

Decode percent-encoded storage URI keys before passing them to object storage providers. This fixes legacy assets such as `logo@2x.png` across S3, R2, Firebase, and Supabase while preserving encoded HTTP paths for CloudFront and CDN downloads.
