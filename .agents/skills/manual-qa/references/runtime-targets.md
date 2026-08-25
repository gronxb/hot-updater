# Runtime Targets

The `hot-updater-agent manual start` handoff is authoritative for the actual
worktree, ports, URLs, artifact, app ID, device, and agent-device commands.
The values below explain the repository contract; never use them to override a
different returned handoff.

## Workspace And Server

- Example: `<handoff.worktreePath>/examples/v0.85.0`
- Scenario root: `<handoff.scenarioRoot>`
- Injected profile: `<handoff.envTargetPath>`
- Control API: `<handoff.controlBaseUrl>`
- Runtime config: `<handoff.runtimeConfigUrl>`
- Update server: `<handoff.appBaseUrl>`

The control server owns deploy jobs, proxy controls, runtime screen state,
metadata waits/assertions, crash recovery assertions, and cleanup. A control
response containing `jobId` is asynchronous and must be polled at
`GET /e2e/jobs/<jobId>`.

## iOS

- Default installed identifier: `org.reactjs.native.example.HotUpdaterExample`
- Release artifact shape: `HotUpdaterExample.app`
- Native state is under the installed app data container's
  `Documents/bundle-store`.

## Android

- Default package: `com.hotupdaterexample`
- Release artifact shape: `app-release.apk`
- Native state is under
  `/sdcard/Android/data/<package>/files/bundle-store`.
- The prepared session configures the required service and control-port
  `adb reverse` mappings and removes them on stop.

## Focused Evidence Routes

The route-based app exposes focused evidence instead of one long page:

| testID | Deep link |
| --- | --- |
| `runtime-bundle-id` | `hotupdaterexample://e2e/runtime-bundle` |
| `runtime-release-state` | `hotupdaterexample://e2e/runtime-release-state` |
| `runtime-large-e2e-asset` | `hotupdaterexample://e2e/runtime-large-asset` |
| `runtime-scenario-marker` | `hotupdaterexample://e2e/runtime-marker` |
| `launch-status-result` | `hotupdaterexample://e2e/launch-status` |
| `launch-transition-result` | `hotupdaterexample://e2e/launch-transition` |
| `crash-history-count` | `hotupdaterexample://e2e/crash-history-count` |
| `action-install-current-channel-update` | `hotupdaterexample://e2e/action/install-current-channel-update` |
| `action-install-runtime-channel-update` | `hotupdaterexample://e2e/action/install-runtime-channel-update` |
| `update-action-result` | `hotupdaterexample://e2e/update-action-result` |

Open the route that owns the assertion and take a fresh interactive snapshot.

## Native State

Relevant files are:

- `bundle-store/metadata.json`
- `bundle-store/launch-report.json`
- `bundle-store/crashed-history.json`
- `bundle-store/<bundle-id>/...`

Metadata-v2 contains stable/staging selection receipts plus authority/scope
catalog high-water. Launch reports contain directional Release and Bundle IDs.
