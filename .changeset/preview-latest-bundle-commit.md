---
"hot-updater": patch
---

The preview comment says what the sandbox QR code opens: "Scan to open the latest bundle on `pr-12`", with the latest commit linked under it on the repository's own server, in place of the "Deployed" footer note. That commit is the one the job checked out, and each preview bundle's deploy message starts with it, `abc1234 · #12 Fix login`, so the sandbox app shows it too. The docs' workflow checks out the pull request's head commit.

A platform that fails no longer stops the others. When another platform deployed, the comment shows only that platform and links the failed one to the run, and the job still fails.
