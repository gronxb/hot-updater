---
"@hot-updater/apple-helper": patch
---

A Simulator build compiles for Apple silicon only (`ARCHS=arm64`), half the work of the arm64 and x86_64 build a generic Simulator destination made. A scheme's `xcconfig` or `extraParams` that sets `ARCHS` still decides. The preview action runs as parallel jobs: each build job sets a `result` output with `comment: false`, the iOS build jobs build without deploying with `deploy: false`, a Linux job deploys the one iOS bundle after both with `build: false`, against the builds their `results` name, compiling and looking up nothing, and a final `mode: comment` job writes the one comment and its QR codes from every job's result, checking the pull request's head before writing and again just before the comment. QR codes stay on the `hot-updater-preview` branch until the pull request closes.
