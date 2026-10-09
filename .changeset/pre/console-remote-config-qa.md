---
"@hot-updater/console": patch
---

Console fixes from a pass over Remote Config:

- In the parameter editor, a condition's value now has a **Remove value** button instead of a trash icon, and the help text says the condition stays. A value removed in the same edit comes back when you add its condition again, instead of starting empty.
- Dialogs keep their content while they close: deleting a condition no longer flashes "Delete ?" and "0 parameters", and the version, rollback, channel, parameter and condition dialogs no longer empty or switch to their "Add" state on the way out.
- A condition named after its rules keeps following them: editing its rules renames it, and parameters' values follow the new name.
- Publish changes lists what an added parameter or condition sets, and a rollback's version row no longer repeats "Rollback to version N" beside its badge.
- The pickers for adding a condition value or a rule open below their button; invalid values outline their field; condition names and values in the parameter list wrap to two lines instead of being cut off on a phone.
- The sidebar lists Bundles, Insights, Remote Config, then API keys.
