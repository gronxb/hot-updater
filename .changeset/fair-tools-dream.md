---
"@hot-updater/apple-helper": patch
"@hot-updater/cli-tools": patch
"@hot-updater/react-native": patch
"hot-updater": patch
---

Run the `hot-updater` CLI from native ESM on Node 20 so TypeScript config
files load through ESM import conditions.

Require Node.js 20.19.0 or newer for the CLI package surface.

Run the `hot-updater` CLI bin from the native ESM entrypoint and stop emitting
a CommonJS build for the CLI entry.

Bump the `hot-updater` CLI package's vulnerable `kysely` and
`fast-xml-parser` dependency entries to patched versions without pnpm
overrides.
