---
"@hot-updater/bsdiff": patch
---

Keep the checked-in WASM asset unchanged during ordinary package builds.
Regenerate it explicitly with `build:wasm` when updating the Rust implementation,
so local toolchain differences do not change the tested artifact.
