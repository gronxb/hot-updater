---
"@hot-updater/apple-helper": patch
---

Use a scheme's `xcconfig` on simulator builds too. It was only used when archiving, so a simulator build silently left it out.

A scheme's `xcconfig` that sets one of the build's own settings with a condition such as `[config=Release]`, already refused when archiving, is now refused on a simulator build too.
