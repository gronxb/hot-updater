---
"@hot-updater/console": patch
---

On a phone, a dropdown's scroll arrows no longer sit over an option. Since rc.37's 44 px rows, a dropdown that scrolls, such as Native builds' Channel or Promote's Target Channel, opened with an arrow over an option's center, so tapping "All channels" scrolled the list instead of choosing it. Below md, a dropdown now opens below its trigger, showing the list from its first option and scrolled to the chosen one, and has no scroll arrows; a swipe, the wheel, or the keyboard scrolls it. Promote's Target Channel list also takes the height a phone has. Desktop dropdowns are unchanged.
