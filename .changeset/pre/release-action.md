---
"hot-updater": minor
---

Add the `actions/release` GitHub Action, the one step a push to a release branch needs. On each platform it looks up the project's fingerprint and deploys a bundle when a store build has it, or builds a native build and submits it to TestFlight or Google Play's internal track when none does. A tracked build with no recorded submission goes through `native-build --submit` again, so rerunning a failed submit can't turn green on a bundle. `dry-run: true` only prints each decision. The `result` output and the job's summary show every platform; a failed lookup deploys and builds nothing, and a platform that fails fails the run without stopping the other one.
