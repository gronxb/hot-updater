# Hot Updater documentation

The Waku/Fumadocs site serves current v1 documentation from
`content/docs/(latest)` at `/docs/...`. Archived v0 content lives in
`content/docs/v0` at `/docs/v0/...`. Change latest content for current behavior;
keep version-transition instructions in `guides/upgrade-to-v1.mdx` and preserve
historical release/architecture records.

## Content ownership

The sidebar starts with onboarding and custom update flows, followed by the
independent **Self Hosting (Managed)** and **Self Hosting (Custom)** groups.
Delivery, operation, security and concepts have their own groups. **React Native
API**, **Build Plugins**, **Storage Plugins**, **Database Plugins** and
**Integration Plugins** remain directly visible, independently searchable
references. Existing URLs stay stable; a sidebar group need not be the physical
directory containing its pages.

- Start here routes readers to agent or manual setup. Installation owns package
  selection; App Setup owns shared runtime/native integration; Test an OTA
  update owns release-build verification. Provider recipes link to those tasks.
- Use `init + checkForUpdate` as the default app flow; the app controls download
  and restart timing. `wrap` remains the optional automatic startup integration.
- Infrastructure recipes own provider-specific resources, configuration and
  verified endpoint/client-key outputs. Custom CLI setup owns the connection
  task; plugin references own configuration and transport contracts.
- Operating guides own deployment, diagnosis and reporting workflows. Console
  links to the Insights guide; signing recipes link to shared native-key rollout
  and rotation instructions.
- Symbol and plugin references stay individually addressable. Link to a tutorial
  instead of repeating it in every method or provider page.

The [PRD](../plans/docs-v1-onboarding/prd.md),
[86-page audit](../plans/docs-v1-onboarding/page-inventory.md), and
[decision record](../plans/docs-v1-onboarding/decisions.md) explain the structure.
The [v1 change coverage](../plans/docs-v1-onboarding/breaking-changes-coverage.md)
maps the release's contract changes to current guides and migration instructions.

## Navigation and links

Each visible group has a `meta.json` with an explicit `pages` order. Entries can
refer to sibling directories, for example `../guides/ai-agents`. Use a single
sidebar owner per page. Group pages by their purpose, not their old directory.

Keep public URLs when renaming a title or changing sidebar ownership. When
splitting content, preserve useful original heading anchors with short links to
the new owner. Link to canonical folder indexes without `/index`, such as
`/docs/guides/console-deployment`. Prefer root-absolute `/docs/...` links and
verify fragments after moving or renaming headings.

## Agent-readable output

Production builds generate `/llms.txt`, `/llms-full.txt`, `/docs/<path>.md` and
`/api/markdown/<path>.md`. The default index/full files contain latest content;
v0 Markdown is generated separately. The LLM index follows the Fumadocs page
tree used for human navigation. Tab and accordion labels remain readable so
agents can distinguish alternative procedures. Fenced code must survive
serialization without losing imports or JSX.

## Develop and verify

Use the repository's `.node-version` and package manager. From the repository
root:

```sh
pnpm install --frozen-lockfile
pnpm --dir docs dev
```

Before submitting a docs restructure:

```sh
pnpm --dir docs test:docs
pnpm --dir docs build
pnpm --dir docs test:type
pnpm -w lint
pnpm -w test
```

The docs checks cover page ownership, routes, fragments, assets and Markdown
output. The build also checks current documentation integrity. Inspect the
rendered entry page, the agent/manual handoff, mobile navigation and Markdown
copy behavior after changing navigation. Repository unit tests require built
packages on a fresh checkout (`pnpm -w build`).

See [CLAUDE.md](CLAUDE.md) for concise writing and example conventions.
