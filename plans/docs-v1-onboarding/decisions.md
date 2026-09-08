# Adversarial review and decisions

Baseline: `next` at `ac67b805583b423d556ea0d62650b4cd2aa5006b`.
Scope: the 86 v1 latest pages. Four independent audits covered onboarding and
operations, provider/custom-server integration, SDK and policy references, and
machine discovery. A fifth implementer checked the signing split against its
actual configuration. The coordinator verified the material source claims and
reconciled the proposals before implementation.

## 1. Organize by the reader's next task

**Proposal:** Replace eleven product/category shelves with Start here,
Infrastructure, Deliver updates, Operate, Security, Concepts, and Reference.

**Objection:** Renaming shelves does not fix circular setup links, ambiguous
completion or repeated instructions. Moving every file also breaks existing
release links and agent citations.

**Decision:** Put onboarding first, with delivery, operation, security and
concept workflows nearby. Keep Self Hosting (Managed), Self Hosting (Custom),
Build Plugins, Storage Plugins, Database Plugins and Integration Plugins as
independent top-level groups: their boundaries remain useful when users need
configuration or implementation details. The initial umbrella Infrastructure
and Reference folders were removed so these concerns stay directly visible.
Use metadata to organize the concerns. Rewrite entry pages, split distinct
tasks and merge duplicate instructions into named owners. Use task-oriented
canonical URLs when renaming improves the journey; pre-release compatibility
is not a constraint (see section 12).
Keep `/docs/get-started/introduction`, the release-linked agent and upgrade URLs,
and existing symbol URLs. Do not create parallel agent/manual reference trees.

## 2. Split the onboarding task, consolidate its shared steps

**Proposal:** Split the 619-line Basic Usage page into installation,
infrastructure selection, app integration and verification.

**Objection:** More pages can increase handoffs and let an agent claim success
after provisioning. Provider-specific URL, client-key, native and build details
cannot be replaced with a generic "see basic usage" link.

**Decision:** Basic Usage remains the ordered manual hub. Installation owns the
package/channel contract; App Setup owns runtime/native integration. Provider
pages produce concrete server/config/key outputs and hand off to App Setup and
`get-started/test-ota`, titled Test an OTA update. Agent Setup owns
an end-to-end request and a separate result for server, native launch and OTA.
The first OTA test requires a visible change in the same installed release
binary, not merely an upload or selected update ID.

`init + checkForUpdate` is the default onboarding and general-example flow.
The app explicitly owns check timing, download completion and restart consent;
`wrap` remains an optional automatic startup integration with its own reference.
The custom update guide is discoverable in Start here and owns the detailed
workflow instead of duplicating a full tutorial on every API page.

**Evidence checked:** The existing guide has 619 lines; provider recipes repeat
Android/iOS blocks. `packages/react-native/src/index.ts` exposes a selected
`getBundleId` that may change before reload. The existing agent server probe
explicitly excludes artifact download and native verification.

## 3. Target stable releases in latest documentation

**Proposal:** Pin install examples to each package's release-candidate tag
because the audit began during the v1 prerelease.

**Objection:** Latest documentation must remain useful after the stable release.
A temporary prerelease channel would persist in copied commands and agent
prompts, requiring another sweep before every release transition.

**Decision:** Use untagged package names throughout latest installation examples,
agent prompts and migration instructions. Write for the stable v1 release and
keep the RC release as audit context only. The maintainer clarified this policy
after reviewing the first PR. Preinstall the SDK, CLI and chosen build/provider
packages, record installed versions and keep the lockfile. The skill still does
not install or upgrade the CLI by itself.

**Evidence checked:** The initializer's package installer, package manifests and
`areVersionsCompatible` in `packages/hot-updater/src/commands/doctor.ts` informed
the installation prerequisites. A transient registry tag does not define the
long-term documentation policy. No runtime installer change in this PR.

## 4. Retain provider and method references

**Proposal:** Merge provider setup, storage and database pages; combine SDK
getters into a few larger pages.

**Objection:** Mixed-provider integrations need storage without the provider's
database. Framework middleware has distinct mount/auth behavior. Agents search
for exact SDK symbols; a getter and a state-changing reset are different tasks.

**Decision:** Preserve focused provider, adapter, framework and symbol URLs.
Remove shared app integration from provider recipes. Make custom CLI setup the
connection task and standalone repository documentation the options/transport
reference. Keep a complete runnable custom-server quick start. Add an API
overview and the missing v1 state/identity methods, rather than an omnibus API
page. Broader legacy helper expansion is not required for this onboarding PR.

## 5. Make Insights an independent operating task

**Proposal:** Keep metrics inside Console because that is where users view them.

**Objection:** Insights reporting starts by default in the SDK, and its setup,
identity, opt-out and diagnostic semantics matter before Console hosting.

**Decision:** Extract the existing metric definitions and screenshots into a
dedicated Insights guide. Link from Console and SDK setup. Preserve received-
report limits and unique-installation semantics. Document the actual lookup
keys: user ID and installation ID; username is display context.

**Evidence checked:** SDK init/wrap default `insights: true`; native `setUser`
normalization and clearing; Console Insights RPC and installation-search label.
The release blog is historical and remains unchanged.

## 6. Split signing by execution environment

**Proposal:** Keep all signer choices in one 659-line guide.

**Objection:** The recommended local path follows hundreds of lines of AWS,
Google and remote-service instructions. Those tasks require different tools and
credentials; extracting shared trust-anchor rules into every recipe would drift.

**Decision:** Keep signer selection, native trust-anchor rollout, rotation and
troubleshooting at the original URL. Extract Local, AWS KMS, Google Cloud KMS
and remote-service recipes. Retain old section headings as compatibility links
and link recipes back to shared lifecycle instructions. Preserve all signing
protocol identifiers. Correct the local CI recipe so its temporary key path is
actually read by the shown configuration.

## 7. Use one navigation model for humans and agents

**Proposal:** Add task folders to metadata and separately tweak the LLM sorter.

**Objection:** The existing sorter ranks basenames and ignores nested metadata;
metadata-only groups would lose pages. It also emits `/index` for a canonical
folder index, and strips the labels distinguishing mutually exclusive tabs.

**Decision:** Derive generated Markdown URLs and ordering from Fumadocs' loader
and page tree. Preserve branch labels, paragraph separation and fenced code.
Keep latest-only default LLM discovery and separate v0 Markdown. Validate real
absolute internal links and anchors, every page's navigation ownership, and
generated output. Test failure scenarios, not only the happy-path formatter.

## 8. Keep version and scope boundaries explicit

**Proposal:** Use the audit to also refresh v0, the README, release blog, optional
Expo DOM recipes and every unlisted historical SDK helper.

**Objection:** The user explicitly clarified that this is v1 latest writing.
Historical documents are not current onboarding, and optional integrations do
not block the main path.

**Decision:** Preserve v0 and historical release/architecture content. Keep
transition instructions in the existing v1 upgrade guide. Defer the optional
Expo DOM split; its anchored section remains available. The later concern review
justified extracting standalone storage into its own plugin family (section 10).
Update only maintainer guidance directly needed to sustain the new
navigation and validation contract. No runtime API or infrastructure changes.

## 9. Challenge the implemented paths before acceptance

Independent reviewers walked the actual agent/manual paths and re-read the
machine-output implementation after the first edits. These findings changed
the implementation:

| Challenge | Accepted correction |
| --- | --- |
| A manual user does not have the agent scaffold's server-probe file | Verify delivery through the actual native app's check/download/restart flow. The initial inline protocol probe was removed after reader review; it imposed server implementation details on onboarding (section 12). |
| Local HTTP custom-server success does not establish a usable native release endpoint | Require reachable HTTPS before the native/OTA handoff, including the Docker hosting path. |
| The Fumadocs search stringifier removes headings and link destinations | Use the Markdown-specific stringifier and verify all corpus code blocks and link destinations survive. |
| A public directory can accidentally bypass page/fragment validation | Only allow an existing public file to satisfy the asset check; check document routes and anchors otherwise. |
| Folder indexes have both canonical and historical filename-based Markdown URLs | Resolve the canonical page first and retain the `/index.md` alias; test unknown aliases returning 404. |
| `@hot-updater/test-utils` is private and cannot be installed from npm | Describe the repository workspace helper and run the documented mock-provider conformance command. |

These fixes preserve the accepted page ownership and version scope. Final
verification evidence is recorded in the [PRD](prd.md#delivered-result-and-verification).

## 10. Preserve concerns while making onboarding actionable

Two independent reviewers challenged the implemented navigation: one checked
the actual Fumadocs/Markdown ownership tree, and one checked provider, server
and plugin responsibilities against the content. Both accepted independent
root groups for the six concerns below and rejected adding Infrastructure or
Reference wrapper folders that hide them behind another expansion.

| Concern | Owns | Does not duplicate |
| --- | --- | --- |
| Self Hosting (Managed) | Provision supported provider resources, deploy packaged infrastructure, produce app connection inputs | Storage/database option contracts and shared native app wiring |
| Self Hosting (Custom) | Assemble a server with database adapters, framework handlers, authentication and hosting | Author a new storage/database plugin |
| Build Plugins | Bundler/build-system configuration and native config-plugin options | Provider provisioning or update scheduling |
| Storage Plugins | Object transport, URI ownership, runtime bindings and download URL configuration | Release policy or database schema |
| Database Plugins | Official models, queries, atomic commits, schema and repository transport | Native app setup or object transfer |
| Integration Plugins | External observability integrations and source-map processing | Core client initialization or provider infrastructure |

The reviewers requested these concrete changes before acceptance:

- **Choose before installing.** Move Choose infrastructure before Install
  packages and make the same prerequisite explicit in manual setup.
- **Give storage its own owner.** Extract `standaloneStorage` from the database
  repository page into Storage Plugins. Keep the original remote-storage anchor
  as a compatibility link. A cross-link alone would leave the full contract in
  the wrong concern.
- **State all plugin responsibilities.** Add Integration to the plugin-system
  overview and describe database use during both deployment and server runtime.
- **Keep the preferred flow consistent.** Remove the wrap reference's claim
  to be the standard approach. App setup owns one working init/check/download/
  restart example; Control update timing owns optional deeper customization.
  Put the first OTA check immediately after app setup in navigation.
- **Remove inactive menu owners.** Retire the unreferenced latest Guides and
  Policy metadata so authors cannot accidentally edit inactive navigation.

Rejected alternatives: merging provider recipes with storage/database contracts
(breaks mixed-provider lookup), restoring umbrella folders (hides the requested
concerns), requiring the long custom-flow guide before the first OTA (adds an
unnecessary onboarding step), and removing wrap support (it remains a valid
automatic integration).

## 11. Shorten the agent entry without losing the execution contract

**Proposal:** Replace the landing's package/init commands with skill installation
and one agent request; shorten the detailed agent prompt to two sentences.

**Challenge:** Skill installation alone does not install a compatible CLI. The
upstream workflow covers discovery, infrastructure and package setup, but does
not independently select `init`, a test channel or a rollback drill. An
infrastructure-only request also does not authorize publishing a test OTA.

**Decision:** Label Terminal and Your agent separately. The landing request
explicitly includes installation, setup and an OTA test, and its Get Started
link opens the agent guide. The guide retains `HotUpdater.init`, a custom flow,
a native Release build, a test channel and rollback in two sentences. Its
evidence table and canonical integration/verification links own the details.
Keep discovery and provider execution in the skill and generated instructions.

An independent reviewer checked the
[upstream skill contract](https://github.com/hot-updater/skills/tree/938db2c637df2421718edbc847d550ecaec8d294/skills/hot-updater)
and matched it to the packaged infrastructure instructions. List-only skill
discovery succeeded without installing into the user's project. The current
npm stable CLI is still v0 at verification time; the page requires a compatible
v1 CLI rather than silently selecting a prerelease channel.

**Terminal challenge:** Bare line feeds retain xterm's current column, fixed
viewport-based columns exceed the actual card width, and the resize effect
recreates the terminal. Together these clipped the final deployment ID.

**Decision:** Use explicit carriage-return/newline handling, size columns from
the container and loaded font, and preserve one terminal through resizing.
Show the actual deploy context/task labels and a complete public update ID in
a compact demo. Put the ID on a separate line so resizing preserves it. Cancel
animation work when the component unmounts. Omit the decorative banner and
redundant upload percentage; keep the deployment result visible.

## 12. Make the first OTA walkthrough readable without protocol knowledge

**Reader finding:** The first OTA guide required a long JavaScript heredoc to
encode Catalog URLs and validate MIME types, scope keys and cache directives
before the reader reached a native build. It also mixed normal delivery,
force-update behavior, two initialization styles and operational diagnostics.

**Challenge:** Removing that script must not turn a passing `/version` response
or a staged update ID into a claim of successful app delivery. A fresh test
channel may have no Catalog before the first deployment, so a pre-deploy check
is not a useful onboarding gate.

**Decision:** Use one four-step walkthrough: install a Release baseline,
publish a visible JavaScript/asset change, check/download/restart in that same
app, then disable the exact test update and observe rollback. Keep the app
sample's error handling, post-restart ID and visible-change evidence. Use short
commands and show only the selected build tool and compatibility strategy.
Required updates, crash recovery and reporting detail remain with their owning
guides. Client-access troubleshooting belongs in Doctor; the generated agent
probe continues to own the independent server/protection-boundary checks.

Rename the page to `get-started/test-ota` and update all latest inbound links.
The maintainer explicitly prefers the final pre-release structure over URL
compatibility, so do not add an old-page alias or retain the removed probe's
anchor. Remove the strategy guides' encoded curl examples and update upgrade
and catalog-repair handoffs to use the actual app flow.

An independent reviewer checked the SDK's callback-error behavior, fresh-channel
404 behavior and the separate responsibilities of Doctor, Catalog preflight,
the agent probe and native OTA application. This changes the required reader
workflow without changing any runtime API or server protocol.

## 13. Keep initialization and error handling idiomatic

**Reader finding:** The examples stored check errors in an outer variable and
threw them after the callback. The app sample also initialized inside an effect
and required an app-ready callback before enabling its check button. These
patterns made routine configuration look like a custom state machine.

**Challenge:** `checkForUpdate` can report a failure through the configured
handler and resolve `null`; downloads and reloads can reject separately.
Moving initialization must preserve both paths without inventing a new API
contract or treating `null` as a successful up-to-date result.

**Decision:** Initialize at module scope, outside React components and effects.
Use the shared `init.onError` reporter for lifecycle/check errors and ordinary
`try/catch` for rejected operations. Shared reporters accept `unknown` and do
not throw. Remove callback capture, readiness gates and redundant state. Use
runtime checks to narrow Expo environment values instead of non-null assertions.

App setup now owns one **Check and apply update** button. It waits for a
successful download before reloading for either normal or required updates.
The first OTA and rollback steps use that same action. Control update timing
owns the optional background workflow, confirmation handler and small store
progress component; channel switching stays in its dedicated guide.

An independent reviewer verified native startup polling, the global error
handler fallback and download/reload behavior against the SDK implementation.
Native bundle loading owns crash monitoring and first-render verification;
initialization observes/reports that result. The extracted app example passes
seven scenarios: no selection, a reported
check failure, a false download result, a rejected download, normal/required
updates waiting for download completion, and a rejected reload. Eight example
units pass strict TypeScript checking against built SDK and React Native types,
including both Expo environment configurations. No runtime API change is needed.

## 14. Show the edit while keeping copied code usable

**Reader request:** Apply Fumadocs added/removed line notation throughout the
latest snippets wherever it helps readers identify what they need to change.

**Challenge:** Coloring every line of a complete example hides its important
parts. JSON and XML need valid language-specific comments. The installed
Fumadocs copy button also includes removed diff lines unless they carry its
copy-ignore class, which can produce duplicate properties or two native loaders.

**Decision:** Review all 514 blocks across 100 latest pages. Highlight inserted
imports/options/hooks within surrounding context and mark removals only for
actual replacements. Keep commands, generated output, complete modules and
API/type references plain. Add file titles where they identify the edit target.
Use JSONC and XML comments; keep ignore-pattern annotations on separate lines.

Reuse the default Fumadocs transformers and mark removed lines with
`nd-copy-ignore` after diff rendering. This keeps red lines visible while its
built-in copy button copies the applied code. Markdown retains both sides and
notation so agents can understand the edit. No custom copy component is needed.

Independent concern reviews and a separate app/SDK cross-review accepted the
final scopes and range boundaries. All 120 annotated blocks render the expected
618 additions and 13 removals without leaking notation. Five renderer regression
scenarios and actual browser copies verify the resulting code. The
[page-by-page snippet inventory](code-snippet-audit.md) records all decisions.

## Remaining limits

- Content/source review and route checks do not prove actual OTA delivery for
  every provider or device. The guide defines that user verification procedure;
  this PR does not provision infrastructure or publish an OTA update.
- No measured time-to-first-update claim: navigation and task completion are
  verified structurally and through cold-reader review, not a user study.
- Existing app-store policy references remain guidance links, not approval
  guarantees; legal interpretation is outside this documentation restructure.
