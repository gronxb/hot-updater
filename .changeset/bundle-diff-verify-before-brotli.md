---
"hot-updater": patch
---

Patch creation (`hot-updater patch` and the patches `deploy` creates) checks every Hermes bundle it downloads against the manifest's SHA-256 hashes, and checks a Brotli-compressed one before decoding it. Storage bytes that deploy did not upload no longer reach Node's Brotli decoder (CVE-2026-111497) or a patch.
