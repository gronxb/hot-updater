# PRD: Infrastructure scaffolding and agent setup/upgrades

Status: implemented and locally verified.
Base: `next`, commit `47caf8a45`.
Working branch: `codex/agent-setup-upgrade`.

## Problem

Interactive `hot-updater init` owns authentication, resource selection,
provisioning, deployment, and local config generation. Its `--from-env-file`
mode removes prompts, but still re-enters the whole initializer after a failure.
Some resources can be reused, yet agents cannot independently resume every
provider step or use their already connected provider MCP/browser capabilities.

An AI agent needs version-correct deployment artifacts, explicit prerequisites,
verification criteria, and recovery instructions. It should manage each remote
step using the capabilities available in its host environment.

Infrastructure requirements also need upgrade instructions at the moment a
maintainer changes the version required by doctor. Recording only a version and
short reason allows migrations, deployment order, and provider differences to be
forgotten before release.

## Outcome

A user says “Use hot-updater agent infra setup to configure and deploy this
project.” The agent reads the command's instructions, inspects local and remote
context, asks only for missing choices/access, generates a provider scaffold,
applies it using available tools, and verifies the result. It can resume after a
failure without recreating successful resources.

For existing installations, the user requests `hot-updater agent infra upgrade`.
The agent obtains a separate target scaffold and versioned upgrade requirements,
compares them with the previous and actual deployment, and applies the relevant
changes. The first recorded infrastructure transition is v0 to v1.

## Decisions

| Topic | Decision |
| --- | --- |
| Commands | `hot-updater agent infra setup` and `hot-updater agent infra upgrade` |
| Public extraction command | `hot-updater infra scaffold --provider <provider>` works without an agent or an app build selection |
| Reuse boundary | Public extraction and agent commands call the same scaffold implementation; agent mode adds instructions, app config and deployment state |
| Meaning of `agent` | AI-only instructions/artifacts; this does not configure or start an agent |
| Meaning of `infra` | Provider server infrastructure and local integration config templates |
| Providers | Cloudflare, Supabase, AWS, Firebase in the first implementation |
| Builds | Bare, Rock, Expo, matching existing init |
| Execution owner | The user's AI agent, through available MCP, provider CLI/API, or browser tools |
| CLI responsibility | Local scaffolding, version information, paths and actionable instructions |
| Existing init | Remains available for interactive setup and env replay |
| Template source | Share existing provider runtime, migrations and config builders |
| Upgrade target | The concrete versions packaged with the invoked CLI, recorded in its manifest |
| Upgrade requirements | One typed registry feeds both doctor requirements and generated upgrade notes |
| Initial transition | Explicit v0-to-v1 coexistence/cutover instructions, not an in-place conversion |
| Delivery | Implementation, documentation, changeset, verification and a PR against `next` |

The proposed names `agent init`, `agent setup`, and `infra setup` were replaced
by the nested `agent infra` commands to make both the AI audience and the target
of the operation explicit.

## Command behavior

### Public server template extraction

```sh
hot-updater infra scaffold --provider cloudflare
hot-updater infra scaffold --provider supabase --output ./server --json
```

Require only a provider. Extract server deployment artifacts, resource input
names, original file hashes, target versions and UPGRADE-NOTES.md. Do not require
or evaluate an app config, ask for a build plugin, or include agent workflow,
app configuration or deployment state files. Use the default directory
`hot-updater-infra/<provider>/scaffold-<cli-version>` and the same output
preservation rules as agent commands. This supports manual and scripted use.

`agent infra setup/upgrade` reuse this extraction implementation and extend its
output with agent instructions, the selected app config and deployment record.
Do not implement or package a second provider server template. Tests compare
every server artifact across public extraction, agent setup and agent upgrade.

### Agent commands

```sh
hot-updater agent infra setup
hot-updater agent infra setup --provider cloudflare --build expo
hot-updater agent infra upgrade --provider supabase --build bare
hot-updater agent infra setup --provider aws --build rock --output ./infra/aws
hot-updater agent infra setup --provider firebase --build bare --json
```

With incomplete selections, print a concise bootstrap guide. Explain the
available providers/builds, how the agent should inspect the app, and which
missing decisions to ask about. Do not prompt on stdin or infer a provider from
credentials. No files are written until both provider and build are selected.

With complete selections, generate the provider's files and report absolute
paths to the main instructions, manifest, deployment record, and scaffold root.
Normal results use the shared CLI UI. `--json` emits one machine-readable object
without a banner or other stdout logs. No provider packages need to be installed
in the target app just to generate the scaffold.

Default output paths include provider, operation, build, and CLI version.
`--output` chooses an explicit directory. Existing compatible scaffolds are
preserved, including agent edits and deployment records. Foreign, incompatible,
incomplete, or unsafe destinations fail without replacing files. New scaffolds
are prepared in a staging directory before publication to avoid half-generated
output after a normal error. Changing the CLI version generates a new default
directory; upgrading never replaces the original setup directory.

These commands do not install dependencies, read credential values, evaluate
the target app's config, authenticate, access cloud resources, or deploy. They
must remain usable in an app that has expo-updates so the agent can read the
instructions for migrating it; the existing conflict check remains on execution
commands outside this guide/scaffolding command group.

## Generated artifacts

Each provider receives:

- Common agent workflow and provider-owned setup/upgrade instructions.
- A usable deployment project, including compiled/runtime files and dependency
  configuration, with clearly named placeholders for resource identifiers.
- Provider schema, bindings, indexes, or infrastructure specifications needed
  to configure the supplied runtime.
- Config/env examples for the selected app build and exact package versions.
- A resumable client API-key provisioning helper that persists the plaintext
  key privately before registration and reuses it after an interrupted request.
- A manifest identifying CLI, provider, server and template content versions,
  infrastructure generation, package requirements, and upgrade requirements.
- An initial deployment record with unverified resource IDs and completion
  fields. This is an agent-maintained record, never proof of remote completion.
- Versioned upgrade notes covering all known required transitions.

Credential values do not belong in manifests, step records, instructions, or
terminal output. Real credentials and signing/client keys remain in ignored
local files or provider secret storage. The app receives only the intended
client key, never a provider admin credential.

### Cloudflare

Package the same bundled Worker and D1 migrations as init. Include Wrangler
configuration for DB, BUCKET, BUCKET_NAME, cache settings and compatibility date.
Guide resource discovery/creation, migration tracking, persistent
STORAGE_DOWNLOAD_URL_SIGNING_KEY, deployment, CLI D1/R2 credentials, and endpoint
verification. Preserve bucket privacy and existing Worker routes/custom domains.

### Supabase

Package a prepared Edge Function, Deno configuration and referenced vendored
files, SQL migrations and config.toml. Guide project and bucket creation/reuse,
readiness checks, migration tracking, verify_jwt=false with runtime x-api-key
authentication, local service credentials, and function verification. A single
raw function source file is not a complete deployable artifact.

### AWS

Package the same Lambda@Edge runtime with exact external dependency versions.
Provide current CloudFront cache/origin/distribution specifications and the
authoritative DynamoDB, IAM, SSM and signing requirements. Guide S3/table setup,
IAM role, persisted RSA key pair, numbered Lambda publication in us-east-1,
CloudFront association/propagation, local deployment credentials, and verification.
Keep resource identities and unrelated bucket/distribution policies intact.

### Firebase

Package the built Functions project, package dependencies, Firebase config and
Firestore indexes. Guide project/billing/API prerequisites, default Firestore
and storage readiness, runtime identity, region, hot-updater-v1 deployment,
local application credentials, and endpoint verification. Do not repurpose an
existing default Hosting site during setup or upgrades.

## Agent execution and resume contract

Each step specifies prerequisites, the desired mutation, verification, and retry
behavior. The agent discovers actual connected capabilities rather than assuming
fixed MCP tool names. A project-scoped or read-only connection may lack creation
or deployment capabilities; the agent uses an authorized alternative or asks
for missing access.

After each remote mutation, verify the result and record exact IDs. On a timeout
or unknown result, inspect remote state before repeating the mutation. Never
interpret failed authentication, incomplete pagination, or stale records as proof
that a resource is absent. Reuse existing resources and keys. Do not destroy
resources to retry a later failed step.

The agent verifies the real server generation/version, authenticated client
access, and relevant artifact access. It runs doctor against the actual base URL.
Server setup, native/JS integration, and an OTA test in a native release build
are separate completion claims. No test OTA publication is implied by generating
a scaffold.

## Versioned upgrades and doctor

`infrastructureUpdates.ts` is the single source of required infrastructure
versions and upgrade instructions. Each entry requires:

- Target version and short reason for doctor.
- Compatibility boundaries.
- Ordered common migration/deployment steps.
- Explicit instructions for all four providers, including when no schema
  migration is required.
- Post-upgrade verification criteria.

Doctor derives its requirement from this registry and points agents to
`hot-updater agent infra upgrade`. Generation-0 detection retains its explicit
in-place-upgrade block and can point to the setup command for parallel resources.
Generating instructions is local; applying them still requires provider access.

The build packages the same entries in UPGRADE-NOTES.md. Type checks require every
provider to be addressed. Tests validate nonempty ordered entries, coverage and
packaged notes. Maintainer instructions document this as part of introducing any
new doctor infrastructure requirement. Existing entries remain available so
agents can apply all relevant transitions across skipped versions.

### First entry: v0 to v1

Follow the existing upgrade guide and init generation checks:

1. Record and back up v0 metadata, endpoints, resource identities and config.
   Keep the v0 service available to installed v0 binaries.
2. Create a separate v1 database namespace and endpoint. There is no supported
   in-place protocol/database conversion or automatic policy/history backfill.
3. Cloudflare requires a separate D1 and Worker. AWS requires separate v1
   DynamoDB, Lambda and distribution identities, with isolated v1 role/key
   resources. Supabase and Firebase may reuse the project with separate
   hot_updater_v1_* namespaces and a hot-updater-v1 function.
4. Storage can be shared when access policies and required objects are preserved.
   Do not prune shared storage from only the v1 database's view.
5. Upgrade the CLI/client/provider packages together. Redeploy desired Bundles
   from their source artifacts; adapt automation relying on v0 JSON shapes.
6. Refresh native dependencies and ship a new native binary with the v1 SDK and
   v1 endpoint. Never deliver v1 SDK JavaScript to a v0 binary through OTA.
7. Verify both endpoint populations and v1 catalog, artifact, install, restart
   and rollback behavior. The native local-metadata bridge does not migrate
   the old server. Do not point v1 binaries at v0 infrastructure to roll back.

Sources: `docs/content/docs/(latest)/guides/upgrade-to-v1.mdx`, provider managed
guides, and the provider `iac/*InfrastructureState.ts` checks.

## Acceptance and delivery

- Published CLI discovery and scaffolding run without cloud credentials,
  provider installations, prompts, or network operations in a fresh project.
- All four providers and all three build selections produce complete artifacts.
  Exact runtime dependencies and import maps resolve outside the repository.
- Public `infra scaffold` works without an app/build selection for all four
  providers. Its server files match both agent commands byte for byte.
- Repeated commands preserve customized files and deployment records. Setup
  and upgrade outputs remain separate. Unsafe/foreign output is not overwritten.
- Tests cover actual failure/resume boundaries in local generation and key
  provisioning, artifact validity, and doctor-to-upgrade-note consistency.
- The first upgrade entry accurately describes v0-to-v1 coexistence and the
  different project-reuse rules for providers.
- Update latest-version user docs, provider entry points, maintainer guidance,
  and changesets. Keep v0 documentation behavior intact.
- Pass repository build, type, lint, and unit test checks. Validate a packed CLI
  artifact. Record that live cloud provisioning was not run by this task.
- Review the final diff and open a PR targeting `next`; do not merge it.

## Non-goals

No built-in LLM/MCP client, browser driver, workflow scheduler, or automatic
remote execution. No replacement of existing interactive init. No automatic
in-place v0 conversion, downgrade, infrastructure deletion, or rollout to app
users. No claim that a future undocumented migration is automatically safe.

## Validation

Validated on 2026-09-07 against the base commit above:

- `pnpm -w build`: passed for 26 projects, including documentation and link checks.
- `pnpm -w test:type`: passed for 34 projects.
- `pnpm -w lint`: passed with no warnings or errors.
- `pnpm -w test`: 2,622 tests passed across 286 files.
- Extracted the `pnpm pack` archive outside the repository, linked only declared
  CLI production dependencies, and confirmed provider packages were not
  resolvable from the extracted CLI. Verified standalone extraction for four
  providers and setup/upgrade/resume for all 12 provider/build combinations.
  Server file hashes matched across the public and agent commands.
- No live cloud provisioning, infrastructure deployment, or native OTA run was
  performed. Those require the target account and app environment.
