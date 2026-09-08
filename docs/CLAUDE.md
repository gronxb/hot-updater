# Documentation authoring

Read [README.md](README.md) for the version scope, content ownership, navigation,
agent-readable output and verification commands. It is the canonical maintainer
guide; do not duplicate its page inventory here.

## Scope and structure

- Current v1 documentation lives in `content/docs/(latest)` and is served at
  `/docs/...`. Leave `content/docs/v0` unchanged unless explicitly requested.
- Keep v0/v1 comparisons and transition steps in `guides/upgrade-to-v1.mdx`.
  Preserve literal resource names, API paths and protocol identifiers.
- Organize the sidebar by tasks using explicit `meta.json` order, including
  cross-directory references. Preserve source URLs and useful old anchors when
  splitting or merging content. Every latest page needs one visible owner.
- Separate tutorial outcomes from method/plugin contracts. Shared app/native
  setup belongs in `get-started/app-setup.mdx`; provider pages retain their
  resource/authentication details and link to that integration.
- An agent setup request should discover the app and existing resources first,
  create missing resources within the request, and verify the result. Ask only
  for unresolved choices, login/access or billing. Never ask for secrets in chat.

## Writing

- Write English MDX with `title`, a concise one-sentence `description`, and a
  Lucide or existing brand `icon` in frontmatter.
- After imports, start the body with a `##` heading. Use headings that name the
  task or decision. Keep instructions concrete, short and in execution order.
- Explain prerequisites, the action, its observable result and the next task.
  Do not call scaffolding, deployment or doctor success proof of OTA delivery.
- Use current behavior. Do not add historical comparisons to latest reference
  pages, marketing claims, emojis, or repeated introductions.
- Split a page when its tasks need different prerequisites or execution
  environments. Merge duplicated instructions into one owner with direct links.
  Do not optimize for page count or length alone.

## Examples and package selection

Use a full npm command in a `package-install` fence for installation. The site
provides package-manager alternatives. Latest documentation targets stable
releases: use package names without prerelease tags in installation commands.
The complete package list belongs in `get-started/installation.mdx`.

```package-install
npm install @hot-updater/react-native
npm install hot-updater @hot-updater/bare --save-dev
```

Runtime imports are regular dependencies. Build/deploy/config-only packages are
development dependencies. A package used by both belongs in regular dependencies.
Install the SDK, CLI and selected build/provider packages before init/scaffold.

- Show complete imports for runnable examples. Label partial configuration
  snippets; retain existing storage/database settings when changing one option.
- Use environment-variable names or placeholders for credentials. The app may
  receive its client API key; provider/admin/signing secrets remain server-side.
- Explain that `.env.hotupdater` does not automatically configure the app. Native
  and OTA builds both need their URL/client-key build inputs.
- Preserve code fences, alternative tab labels and paragraph separation in
  generated Markdown. Use explicit named alternatives rather than unlabeled
  consecutive recipes.
- Validate examples against the current source/CLI. Preserve API return values,
  timing, auth boundaries and native compatibility constraints.
