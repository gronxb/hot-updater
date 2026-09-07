---
"hot-updater": patch
---

Exit with code 1 when `hot-updater doctor` fails with an error such as a missing `package.json` or an uninstalled CLI. The default output previously printed "Doctor check failed." and exited 0, so CI treated a failed doctor run as a pass, while `--json` already exited 1 for the same result.
