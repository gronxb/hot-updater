---
"hot-updater": patch
"@hot-updater/cli-tools": patch
"@hot-updater/apple-helper": patch
"@hot-updater/android-helper": patch
---

The commands new in 1.2 print short output that fits an 80-column terminal: one idea per line, `Label  value` rows padded to a common width, paths with `~` or relative to the project and shortened in the middle, and bare highlighted commands without backticks. A result with nothing to do, such as `apple login` with a key already stored, states the result and stops; a next step is printed only when you have to act. `apple login` and `google-play login` name the one place they found the key. Doctor prints each issue and its resolution as one entry, a sentence per line. `--json` output is unchanged.
