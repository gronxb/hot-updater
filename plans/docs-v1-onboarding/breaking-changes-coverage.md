# V1 contract coverage

Source: [BREAKING_CHANGES.md](../../BREAKING_CHANGES.md), checked against the PR's
latest documentation and current `next` implementation. That source records net
breaking contracts and explicitly omits unrelated additive features. This table
covers every section of it, including the current capabilities exposed by those
changes. All paths below are relative to `docs/content/docs/(latest)/`.

Current behavior belongs in the focused guides and references. Removed names,
v0/v1 comparisons and transition steps belong in
[the upgrade guide](<../../docs/content/docs/(latest)/guides/upgrade-to-v1.mdx>).
Install examples target stable releases and use untagged package names.

## Migration and signing

| Contract item | Current documentation owner | Audit result |
| --- | --- | --- |
| Separate v1 endpoint/resources and new native SDK; preserve v0 binaries and endpoint | `guides/upgrade-to-v1.mdx` | Already covered; complete parallel-cutover and device-retention test remain. |
| Upgrade packages together; empty v1 Release history requires redeployment | `get-started/installation.mdx`, upgrade guide | Already covered; stable package selection retained. |
| Managed init and SQL/Mongo schema reject v0 resources/markers before mutation | Upgrade guide, adapter schema guides | Added explicit rejection/empty-storage requirement to migration. |
| Local signing opt-in, disabled/omitted behavior, public identity derived from signer | `guides/signing/local.mdx`, `guides/bundle-signing.mdx` | Covered; made shared signer-option ownership explicit. |
| Local, AWS KMS, Google KMS and remote signers expose their own public identity | Signing hub and four recipes | Covered; no storage/database coupling or duplicate recipe added. |
| Expo publicKeyPath belongs in app config; prebuild uses only public file and fingerprints it | `build-plugins/expo.mdx`, signing hub | Added discoverable plugin option reference; existing public-only/CNG behavior retained. |
| RSA ≥2048, SPKI PEM, every returned signature verified, invalid/missing/mismatched key blocks deploy | Signing hub and local/KMS/remote recipes | Clarified common validation and installed-binary inspection limit. |
| keys generate does not overwrite; export-public defaults to cancel replacement; --yes acknowledges native rotation | Signing hub and local recipe | Already covered. |
| keys export-public --output materializes public file and refuses existing output | Signing hub | Added executable Expo/KMS/remote signer path and exact overwrite behavior. |
| Weak/unsupported old keys require rotation; same key still needs v1 native build; new key ships native-first | Upgrade guide, signing hub | Added explicit migration exceptions and signing.publicKeyPath relocation. |

## HTTP and server composition

| Contract item | Current documentation owner | Audit result |
| --- | --- | --- |
| Shared Release Catalog fetch, local selection, later artifact resolution | `concepts/how-it-works.mdx`, `database-plugins/release-catalog-contract.mdx` | Already covered; exact old/new routes added to migration guide. |
| Unversioned client routes and provider/custom base URL boundaries | Managed guides, `custom/overview.mdx`, framework guides | Covered; framework mount and relative storage URL ownership clarified. |
| Removed SDK-version header and authorityId; internal Catalog identity | Upgrade guide, Catalog contract | Added migration mapping; references keep automatic identity behavior. |
| Separate client/admin handlers and HandlerOptions removal | `custom/overview.mdx`, Hono/Express/Elysia guides | Current handlers covered; explicit migration mapping added. |
| Client owns version, catalog, artifact, signed storage downloads and event ingestion | Custom overview and API-key guide | Expanded exact authentication coverage, including signed-download exception. |
| Admin owns Bundle/Release/catalog/Channel/commit/Insights queries; no client/admin overlap | Custom overview, `database-plugins/standalone.mdx` | Already covered; migration maps explicit mounting and removed features. |
| Admin middleware precedes mount, fails startup without credential, protects every request | Framework guides and custom quick start | Already covered; migration links to those canonical examples. |
| Required clientAccess, configurable headerName and Vary partition | `custom/api-key-authentication.mdx`, Catalog/database contracts | Corrected contract prose that assumed x-api-key instead of the configured header. |
| Insights server routes always exist; SDK reports by default; no server flags/queryAccess | `guides/insights.mdx`, custom overview, init/wrap API | Already covered; old-option mapping added to migration. |
| Standalone exact admin baseUrl, relative fixed request paths, no custom channels route | `database-plugins/standalone.mdx`, `custom/cli-configuration.mdx` | Already covered; migration adds the shared-root/route-override correction. |
| toNodeHandler accepts one handler; runtime bindings/credentials captured at construction | Express guide, custom overview, Worker provider references | Strengthened construction/Request-only contract; migration lists removed contexts. |
| /version infrastructureGeneration check and doctor | `guides/doctor.mdx`, upgrade guide | Already covered; client access and native OTA remain separate verification. |
| Local Console direct database vs standalone admin token vs hosted user authentication | `guides/console.mdx`, Console deployment | Already covered; transport capability limitations retained. |
| Direct defineConfig plugins; createHotUpdater database/clientAccess/storage array | Custom overview, quick start and adapter guides | Clarified direct objects; migration maps thunks and storages/storagePlugins. |
| In-process apiKeys.create/list/revoke, not HTTP handler routes | API-key guide | Already covered with executable examples. |
| Removed cwd/basePath/features/runtime-context configuration | Upgrade guide; current custom/framework references | Added consolidated migration mapping without duplicating old APIs in references. |

## Bundle operations and persistence

| Contract item | Current documentation owner | Audit result |
| --- | --- | --- |
| Public deployment ID vs immutable artifact ID; policy updates recompile catalogs | `concepts/how-it-works.mdx`, deploy, Console, Catalog contract | Already covered; migration now lists field ownership and removed LegacyBundle. |
| Promote reuses bytes, produces a new public ID/seed, supports atomic move | Console, upgrade guide | Already covered, including enabled/100%/no-target-cohort defaults. |
| Exact public-ID disable for rollback; delete disabled Release before unreferenced artifact | Console, `guides/storage-cleanup.mdx` | Already covered; no direct deletion bypass introduced. |
| Bundle.patches replaces singular patch fields | Catalog/custom-database contracts, upgrade guide | Added explicit migration mapping and current artifact-based patch command. |
| Public bundle list/show/update/enable/disable/promote/delete command semantics | Console, deploy, upgrade guide | Already covered, including one disabled public Bundle per delete. |
| Removed top-level rollback and deprecated patch flag aliases | Upgrade guide | Covered; current diffing guide now shows canonical Artifact ID flags with platform. |
| Revision preconditions and policy preflight | Console | Added executable read → preflight → revision-guarded write flow and stale-retry guidance. |
| bundle list/show --json exposes internal rows instead of old wrapper/DTO | Console, upgrade guide | Already covered. |
| db catalog preflight/rebuild and missing identity protection | Doctor, custom-database contract | Added scope selection, result inspection, repair verification and restore-from-backup rule. |
| Self-hosted API-key create/list/revoke, one-time plaintext/hash persistence, rotation | API-key guide | Already covered; adapter-specific schema preparation remains canonical. |
| Managed init creates/registers/reuses HOT_UPDATER_API_KEY; app receives only client key | Managed guides, API-key guide, app setup | Already covered; native and OTA environment handoffs retained. |
| Fixed seven database models, ordered atomic changes/expectations and dispose | Custom database and Catalog contracts | Covered; corrected erroneous AWS commit({ mutations }) in reference and managed guide. |
| Persistent opaque Channel IDs, exact case-sensitive names, channel_id ownership | Custom database/Catalog contract, channel guide | Added user-facing channel-name/persistence boundary. |
| Schema 1.0.0 and no blob-backed substitute for atomic Release/Catalog storage | Adapter guides, custom database, upgrade guide | Covered; removed factory/top-level methods and query DSL migration listed. |
| Flat storage object operations, one-shot Web streams and Response-based reads | `storage-plugins/custom-storage.mdx` | Already covered; removed profiled helper/context/lifecycle mapping added to migration. |
| Validated hierarchical storage URIs, hash-addressed assets, provider-owned download URL policy | Storage contract, S3/R2 references | Covered; explicit S3 download URL configuration strengthened. |
| Optional pruning uses explicit object keys and preserves reference ownership | Custom storage contract, storage cleanup | Added optional list/delete capability shape to reference. |

## SDK and removed provider exports

| Contract item | Current documentation owner | Audit result |
| --- | --- | --- |
| baseURL-only HTTP transport; custom GraphQL/RPC needs full HTTP adapter/proxy | init/wrap API, upgrade guide | Current reference covered; removed resolver/types/authorityId migration added. |
| init and wrap cannot be mixed; custom flow uses init + checkForUpdate | App setup, custom update, init/check APIs | Made init the default onboarding/general-example path; wrap remains optional automatic integration. |
| NotifyAppReadyResult UNCHANGED/UPDATE_APPLIED/RECOVERED and directional/optional IDs | New `react-native-api/notifyAppReady.mdx` | Added complete union, examples, callback-vs-direct-read behavior and API navigation. |
| Old STABLE/crashedBundleId consumers must change | Upgrade guide | Added discriminated-union migration with canonical reference link. |
| Automatic adoption/app-ready reporting with client insights:false opt-out | Insights and init/wrap API | Covered; converted primary reporting example to init. |
| Positional updateBundle overload removed; complete object or selected helper | updateBundle API, custom update, upgrade guide | Current helper covered; explicit old-call migration added. |
| Expo plugin belongs to @hot-updater/expo; runtime SDK remains @hot-updater/react-native | Installation, app setup, Expo reference, upgrade guide | Already covered; plugin publicKeyPath reference added. |
| AWS s3Database → dynamoDB; s3LambdaEdgeStorage → s3Storage | AWS database/storage references, upgrade guide | Current replacements covered; removed-export table added. |
| AWS withCloudFrontSignedUrl → s3Storage getDownloadUrl/cloudFrontDownloadUrl | S3 reference, upgrade guide | Added concrete current SSM/getPrivateKey configuration and mapping. |
| Cloudflare context-derived D1/R2 → explicit native bindings | D1 and R2 references, upgrade guide | D1 covered; added complete Worker-native R2/server composition. |
| Cloudflare/JS JWT helpers → server/provider download URL handling | Storage references, upgrade guide | Added removed-export mapping. |
| Supabase root Edge exports → /edge imports | Supabase database/storage references, upgrade guide | Current imports covered; migration mapping added. |
| JS/Postgres getUpdateInfo → catalog compilation/read and device selection | Catalog contract, upgrade guide | Current behavior covered; removed-export mapping added. |
| plugin-core createBlobDatabasePlugin/profiled storage → fixed database/flat storage | Custom plugin contracts, upgrade guide | Current contracts covered; migration mapping added. |
| plugin-core request update Bundle resolver/seeds → createRequestBundleResolver | Upgrade guide | Added exact removed/replacement names for custom integrators. |
| Retained local Bundle metadata/BUNDLE_ID directories/cohort identity on native upgrade | Upgrade guide, compatibility inventory | Already covered; server/storage/protocol compatibility remains explicitly excluded. |
| Complete preserve → install → scaffold → adapt → sign → redeploy → verify → native release checklist | Upgrade guide | Preserved and linked to current source-owned workflows; no v0 content changes. |

## Review and validation

Independent SDK, server/plugin and signing audits identified the gaps above.
A separate cross-review checked CLI revision/preflight, Catalog restoration,
manual patch prerequisites and migration mappings against implementation.
Navigation and concern boundaries are reviewed separately in the
[decision record](decisions.md).

The follow-up adds a focused launch-result API page and extracts standalone
storage into its own plugin reference. It does not add a second migration tree
or runtime behavior. The final PRD records build, link, Markdown and example checks.
