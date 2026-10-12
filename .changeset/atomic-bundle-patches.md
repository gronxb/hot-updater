---
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"@hot-updater/aws": patch
"@hot-updater/cloudflare": patch
"@hot-updater/firebase": patch
"@hot-updater/mock": patch
"@hot-updater/postgres": patch
"@hot-updater/standalone": patch
"@hot-updater/supabase": patch
"hot-updater": patch
---

Publish binary-delta patch rows atomically across built-in database providers so
concurrent base bundles cannot overwrite each other. Validate manifest paths,
content hashes, download representations and logical asset bytes before patch
generation, while preserving archive fallback for legacy or invalid manifests.
Retain at most 24 deterministically ordered base patches per target Bundle and
reject Bundle deletion while a Release or another Bundle's patch references it,
with the same referenced-row result across providers. Enforce shared manifest,
asset, archive, patch, and response-body size limits before download or publish.
Require canonical SHA-256 patch hashes and support delta publication in both
upgrade and rollback directions. Cap serialized `ArtifactInfo` at 528,384 UTF-8
bytes, resolve changed-file URLs with at most 16 concurrent operations, and use
bounded manifest delivery or archive fallback. Artifact delivery can ignore
corrupt optional patch rows while administrative Bundle hydration stays strict.
Patch replacement retains the superseded storage object. Eager deletion is
unsafe without atomic ownership and reference proof and is deferred to future
cleanup work.
The unreleased Supabase RPC remains solely in the existing 1.0.0 initial
migration. There is no 1.0.1 migration or separate infrastructure upgrade.
