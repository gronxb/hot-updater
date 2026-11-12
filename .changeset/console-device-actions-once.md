---
"@hot-updater/console": patch
---

The iOS devices page keeps this iPhone's actions in one place. The Register card shows the iPhone's state only. Its row in the list carries Approve and the other actions, with a quiet "This iPhone" tag.

Console dialogs no longer show a CLI command that does the same thing as the button.

An iPhone that proved its UDID with the profile once keeps a 30-day HttpOnly, SameSite=Strict cookie, scoped to the device routes. With it, the same signed-in person can request that iPhone again, for example after it was removed, without installing the profile. The cookie is cleared on sign-out.

Every Console route now works better on a phone:
- Inputs use 16 px text, so iOS doesn't zoom in on focus.
- Dialog, sheet, sidebar, and page actions are 44 px tall.
- Dialogs stay within the dynamic viewport.
