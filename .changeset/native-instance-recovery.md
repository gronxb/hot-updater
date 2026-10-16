---
"@hot-updater/react-native": patch
---

Each native instance recovers from its own crashes. A named instance's launch is no longer verified as soon as it is selected.
- A named launch starts when one of its own React Native views is shown in the foreground, and is verified only by its own first content. A runtime warmed up without UI is never charged.
- A JavaScript fatal error or a failed bundle load is charged to the instance whose runtime threw it. Its bundle rolls back at that instance's next start and enters that instance's crash history. Instances whose launch was in progress at that moment are not charged; their pending bundle is selected again.
- A native crash is charged to every instance whose launch is in progress and not yet verified. Instances that already showed content are unaffected.
- Each instance keeps its own crash marker beside its bundles. `main` keeps its paths and behaves as before, including its in-process recovery reload on iOS and its recovery restart on Android.
- A named instance's JavaScript fatal error is not recovered in-process: React Native's default handling ends the app, and the instance rolls back at the next start.
