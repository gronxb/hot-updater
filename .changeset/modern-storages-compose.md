---
"@hot-updater/core": minor
"@hot-updater/plugin-core": minor
"@hot-updater/test-utils": minor
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/supabase": minor
"@hot-updater/standalone": minor
"@hot-updater/server": minor
"@hot-updater/cli-tools": minor
"hot-updater": patch
---

Add Storage V2 as an additive, runtime-neutral plugin API. Storage providers
now accept their configuration directly and return a plugin created with
`createStoragePlugin({ name, protocol, plugin })`, while the existing Storage
V1 contract remains available for compatibility.

Preserve durable artifact URIs across deploy, patch, promote, and server read
paths. Storage V2 implementations can resolve request-scoped configuration
references at the server boundary without coupling provider factories to a
specific runtime.

Publish target-specific storage entries for AWS Lambda, Cloudflare Workers,
Firebase Functions, Supabase Edge, Standalone, and the shared authoring and
test utilities. The entries keep target-only SDKs isolated from neutral
package roots and support their published ESM, CommonJS, and type conditions.

Harden storage lifecycle behavior across first-party providers, including
idempotent teardown, request isolation, stream backpressure and cancellation,
and cleanup after partial initialization failures. CLI config loading now
preserves Storage V2 plugin identity and resolves owner-provided
`ConfigResponse` references without embedding live runtime objects in build
configuration.
