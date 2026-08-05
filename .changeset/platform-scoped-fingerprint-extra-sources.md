---
"@hot-updater/plugin-core": patch
"@hot-updater/cli-tools": patch
"hot-updater": patch
---

feat: support platform-scoped `fingerprint.extraSources`

`fingerprint.extraSources` now accepts `{ ios?: string[], android?: string[] }`
in addition to `string[]`. An array keeps the existing behavior (shared by both
platforms); the object form only feeds the fingerprint of the platform it is
scoped to, so an iOS-only native input no longer moves the Android fingerprint
(and vice versa).

The default config no longer sets `extraSources: []`, which the config deep
merge would otherwise use to clobber a user-supplied object.
