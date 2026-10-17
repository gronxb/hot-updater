---
"hot-updater": patch
---

Record the engine behind each fingerprint. `fingerprint.json` now stores the `@expo/fingerprint` version that computed each hash. When a different version computes a different hash, `doctor`, `deploy`, and `fingerprint create` report that the engine changed instead of listing source changes; `doctor` reports it as `FINGERPRINT_ENGINE_CHANGED`, which `doctor --fix` leaves to you. They also say how to keep updating builds already shipped: go back to that version. Existing hashes are unchanged.
