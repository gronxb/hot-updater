# @hot-updater/react-native

React Native runtime for Hot Updater.

## OTA analytics

`HotUpdater.init({ analytics: true })` enables best-effort analytics reporting.

- Automatic reporting is owned only by `HotUpdater.init({ analytics: true })`
- `HotUpdater.wrap()` does not activate analytics transport
- `notifyAppReady()` now returns exactly one of:
  - `{ status: "UNCHANGED" }`
  - `{ status: "UPDATE_APPLIED", fromBundleId, toBundleId }`
  - `{ status: "RECOVERED", fromBundleId, toBundleId }`
- One report is attempted per JavaScript runtime for all three outcomes
- `UNCHANGED` reports the current bundle without inventing a transition
- The default resolver posts to `<baseURL>/events` and only treats HTTP `204`
  as success
- Delivery is best-effort only. A missing Analytics route, rejected response,
  timeout, or network error is logged as a warning and never blocks app
  readiness or suppresses `onNotifyAppReady`
- Reporting happens at the existing app-ready boundary; it is not a foreground
  heartbeat or a session tracker

## Installation and user identity

- `HotUpdater.getInstallId()` returns a random install-scoped UUID
- The install id survives restarts, OTA updates, and store updates
- Reinstalling the app creates a new install id
- `HotUpdater.setUser({ userId, username })` persists optional user identity
  for future app-ready reports
- `HotUpdater.setUser({ userId: undefined, username })` clears the stored user
  id and optionally updates the username
- `HotUpdater.setUser(null)` clears the stored user envelope for future events only

See https://hot-updater.dev for full setup and server-side analytics usage.
