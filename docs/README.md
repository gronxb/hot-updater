# Hot Updater documentation

The Waku/Fumadocs site serves the current documentation, and only the current
documentation, from `content/docs/(latest)` at `/docs/...`. There is no
archived version and no version selector; `/docs/v0/*` redirects to the same
path in the current docs. Change content for current behavior and keep
v0-to-v1 transition instructions in `guides/upgrade-to-v1.mdx`. Current guides
describe the stable release; do not include release-candidate setup or
migration procedures. Use “Hot Updater” without a major-version label in
general setup and agent workflows. Reserve “v1” for v0 migration guidance; keep
literal resource names, API paths and protocol identifiers.

Do not commit PRDs, plans, audits, measurements or other working notes to the
repository. Describe shipped behavior in `content/docs`; link to a
commit-pinned GitHub URL when a page must cite a record that is no longer on
the branch.

## Content ownership

The sidebar starts with **Start here** and **Concepts**, followed by the
independent **Self Hosting (Managed)** and **Self Hosting (Custom)** groups.
Delivery, operation and security have their own groups. Start here stays short:
the introduction, the agent path, the manual path (a group of its steps:
Choose infrastructure, Install packages, Connect your app), Test an OTA update,
and the v0 migration. Workflows such as Control update timing belong to their
Workflows group. The **Adapters
and Plugins** section starts with its overview: an adapter fills one slot of a
config (build, storage, database, signing), and a plugin is an entry of a
`plugins` list (server, client) or an integration that wraps a build adapter.
It keeps **Build Adapters**, **Storage Adapters**, **Database Adapters**,
**Signing Adapters** and **Integration Plugins** directly visible, then
**Create an Adapter** (storage and database guides and the database adapter
contract), **Create a Plugin** (server and client guides), and **Test and
publish**.
**React Native API** is the reference section. Existing URLs stay stable; a sidebar
group need not be the physical directory containing its pages.

- Start here routes readers to agent or manual setup. Installation owns package
  selection; App Setup owns shared runtime/native integration; Test an OTA
  update owns release-build verification. Provider recipes link to those tasks.
  Control update timing, the app-side half of delivering an update, follows
  Deploy in Deliver updates.
- Use `init + checkForUpdate` as the default app flow; the app controls download
  and restart timing. `wrap` remains the optional automatic startup integration.
- Infrastructure recipes own provider-specific resources, configuration and
  verified endpoint/client-key outputs. Custom CLI setup owns the connection
  task; adapter references own configuration and transport contracts.
- Operating guides own deployment, diagnosis and reporting workflows. Console
  links to the Insights guide; signing recipes link to shared native-key rollout
  and rotation instructions.
- Symbol, adapter and plugin references stay individually addressable. Link to a tutorial
  instead of repeating it in every method or provider page.
- Authoring pages teach one adapter or plugin kind each with an example that
  type-checks against the current packages, and link to Test and publish for
  packaging. The Adapters and Plugins overview owns the list of kinds, the
  official ones and community packages.

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
`/api/markdown/<path>.md` from the current content. The LLM index follows the
Fumadocs page tree used for human navigation. Tab and accordion labels remain readable so
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
