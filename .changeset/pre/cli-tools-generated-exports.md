---
"@hot-updater/cli-tools": patch
---

Let tsdown generate the package's `exports` map instead of a hand-written copy. `import` and `require` still resolve `dist/index.mjs`, and its types still resolve `dist/index.d.mts`.
