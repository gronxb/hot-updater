---
"@hot-updater/console": patch
---

Outline links draw their border again. Links styled as buttons, such as a native build's Download, the empty Native builds table's "Show all native builds", and the pagers' Previous and Next, took the button classes without merging them, so the base's transparent border won over the outline's and an outline link looked like a ghost one. The button classes are now merged wherever they're used, so a link looks like a button of the same variant, and a link's own classes, such as its height or width, override the button's.
