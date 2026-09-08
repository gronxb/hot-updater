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

**Decision:** Use metadata groups to organize existing URLs. Rewrite entry
pages, split distinct tasks and merge duplicate instructions into named owners.
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
the existing simulator-test URL, retitled Test an OTA update. Agent Setup owns
an end-to-end request and a separate result for server, native launch and OTA.
The first OTA test requires a visible change in the same installed release
binary, not merely an upload or selected update ID.

**Evidence checked:** The existing guide has 619 lines; provider recipes repeat
Android/iOS blocks. `packages/react-native/src/index.ts` exposes a selected
`getBundleId` that may change before reload. The existing agent server probe
explicitly excludes artifact download and native verification.

## 3. Preinstall each required package from its own RC tag

**Proposal:** Change the CLI install to `hot-updater@rc`.

**Objection:** The CLI's missing-package installer derives plugin versions from
the CLI version, while the SDK, build plugins and providers have independent RC
numbers. Changing only the CLI leaves first-run installation unreliable.

**Decision:** Install the SDK, CLI, chosen build and provider packages from each
package's own npm `rc` tag before init/scaffold. Record resolved versions and
keep the lockfile. Teach doctor compatibility in terms of release/channel,
not identical package versions. No runtime installer change in this PR.

**Evidence checked:** `packages/hot-updater/src/utils/ensureInstallPackages.ts`,
`packages/cli-tools/src/ensureInstallPackages.ts`, package manifests, and
`areVersionsCompatible` in `packages/hot-updater/src/commands/doctor.ts`.

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
transition instructions in the existing v1 upgrade guide. Defer additional Expo
DOM and standalone-storage splits; their focused anchored sections remain
available. Update only maintainer guidance directly needed to sustain the new
navigation and validation contract. No runtime API or infrastructure changes.

## 9. Challenge the implemented paths before acceptance

Independent reviewers walked the actual agent/manual paths and re-read the
machine-output implementation after the first edits. These findings changed
the implementation:

| Challenge | Accepted correction |
| --- | --- |
| A manual user does not have the agent scaffold's server-probe file | Add a self-contained client-access probe to the shared OTA test guide. Check anonymous rejection and valid authenticated responses without printing the key; verify six mocked outcomes. |
| Local HTTP custom-server success does not establish a usable native release endpoint | Require reachable HTTPS before the native/OTA handoff, including the Docker hosting path. |
| The Fumadocs search stringifier removes headings and link destinations | Use the Markdown-specific stringifier and verify all corpus code blocks and link destinations survive. |
| A public directory can accidentally bypass page/fragment validation | Only allow an existing public file to satisfy the asset check; check document routes and anchors otherwise. |
| Folder indexes have both canonical and historical filename-based Markdown URLs | Resolve the canonical page first and retain the `/index.md` alias; test unknown aliases returning 404. |
| `@hot-updater/test-utils` is private and cannot be installed from npm | Describe the repository workspace helper and run the documented mock-provider conformance command. |

These fixes preserve the accepted page ownership and version scope. Final
verification evidence is recorded in the [PRD](prd.md#delivered-result-and-verification).

## Remaining limits

- Content/source review and route checks do not prove actual OTA delivery for
  every provider or device. The guide defines that user verification procedure;
  this PR does not provision infrastructure or publish an OTA update.
- No measured time-to-first-update claim: navigation and task completion are
  verified structurally and through cold-reader review, not a user study.
- Existing app-store policy references remain guidance links, not approval
  guarantees; legal interpretation is outside this documentation restructure.
