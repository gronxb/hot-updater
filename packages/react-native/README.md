# Hot Updater

A self-hostable OTA (Over-The-Air) update solution for React Native.

## Bundle Lifecycle Analytics

The React Native SDK keeps app-ready lifecycle analytics vendor-neutral through
`analytics.telemetryKey` for standard `baseURL` setups and
`resolver.notifyAppReady` for custom runtimes. The notifier receives the current
bundle identity, anonymous install id, event id, platform, channel, and native
app-ready status: `STABLE` or `RECOVERED`.

For standard runtime URLs, configure a project-scoped publishable `hutk_`
telemetry key next to `baseURL`:

```ts
import { HotUpdater } from "@hot-updater/react-native";

const runtimeBaseURL = "https://api.hot-updater.cloud/p/prj_...";

HotUpdater.init({
  analytics: {
    telemetryKey: "hutk_publishable_project_telemetry_key",
  },
  baseURL: runtimeBaseURL,
});
```

The SDK posts app-ready lifecycle telemetry to
`{baseURL}/api/notify-app-ready` with `Hot-Updater-SDK-Version` and
`x-hot-updater-telemetry-key` headers. Keys that do not start with `hutk_` are
rejected before initialization starts.

Custom resolvers remain authoritative. If you provide
`resolver.notifyAppReady`, the SDK does not replace it with the analytics
composition path. If your custom resolver only replaces `checkUpdate`, keep
`baseURL` and `analytics.telemetryKey` in the SDK options and the default
app-ready notifier will be composed for you. You can also use the lifecycle
notifier directly when you need to wire it manually:

```ts
import { createDefaultResolver, HotUpdater } from "@hot-updater/react-native";
import { createHotUpdaterCloudLifecycleNotifier } from "@hot-updater/react-native/cloud";

const runtimeBaseURL = "https://api.hot-updater.cloud/p/prj_...";

HotUpdater.init({
  resolver: {
    checkUpdate: createDefaultResolver(`${runtimeBaseURL}/api/check-update`).checkUpdate,
    notifyAppReady: createHotUpdaterCloudLifecycleNotifier({
      baseURL: runtimeBaseURL,
      telemetryKey: "hutk_publishable_project_telemetry_key",
    }),
  },
});
```

The notifier does not forward deploy/admin request headers and maps SDK
`STABLE` to runtime `ACTIVE` while preserving `RECOVERED` for rollback/recovery
attribution. HotUpdater Cloud stores only a hash/suffix of this key and accepts
it only for the matching project. The Cloud project settings screen shows the
suffix and can rotate or issue the plaintext key for SDK configuration.

Telemetry keys are not deploy API keys or signing keys. A `hutk_` key only
authorizes app-ready metrics writes to `/api/notify-app-ready`; deploy API keys
publish or mutate bundles, and signing keys verify bundle integrity.
