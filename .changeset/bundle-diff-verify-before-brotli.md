---
"hot-updater": patch
"@hot-updater/cli-tools": patch
"@hot-updater/azure": patch
---

Require Node.js 22.23.4+, 24.22.1+, or 26.12.1+, the releases that fix CVE-2026-111497 in Node's Brotli decoder. Node.js 20 is end of life and gets no fix.

Patch creation (`hot-updater patch` and the patches `deploy` creates) first checks each manifest against the bundle's recorded `manifestFileHash`, verifying a signed one with the configured signing public key, then checks every Hermes bundle it downloads against the manifest's SHA-256 hashes, a Brotli-compressed one before decoding it. Storage bytes that deploy did not upload no longer reach the Brotli decoder or a patch.
