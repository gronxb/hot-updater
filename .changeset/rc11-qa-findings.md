---
"hot-updater": patch
---

Say what a missing secret means and how to store it, and count a missing upload keystore once.

- A missing `secret()` that nothing reads yet, and one that an adapter reads on the next deploy, now print as `▲` warnings with a reason and a next step, as doctor's other warnings do. A build credential names the command that stores it, which imports a signing key and never issues a new one. An adapter credential names its `.env.hotupdater` variable and `npx hot-updater secrets import`, or, without a team store, the variable to set. The Secrets block itself is `◇`, and `--json` keeps the same codes and fields, with the new `message` and `resolution`.
- A release's missing upload keystore is counted once, as the Secrets error. The Google Play row still marks the package `✗ upload keystore missing`, but is no longer a warning of its own when that is its only problem: `Doctor found 1 error.` rather than `1 error, 1 warning`.
