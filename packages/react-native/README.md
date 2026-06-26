# Hot Updater

A self-hostable OTA (Over-The-Air) update solution for React Native.

## Bundle Lifecycle Analytics

The React Native SDK keeps app-ready lifecycle analytics vendor-neutral through
`resolver.notifyAppReady`. The resolver receives the current bundle identity,
anonymous install id, event id, platform, channel, and native app-ready status:
`STABLE` or `RECOVERED`.

HotUpdater Cloud ships the first opt-in runtime adapter:

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

The Cloud adapter uses a project-scoped publishable `hutk_` telemetry key, does
not forward deploy/admin request headers, and maps SDK `STABLE` to Cloud
`ACTIVE` while preserving `RECOVERED` for rollback/recovery attribution. Cloud
stores only a hash/suffix of this key and accepts it only for the matching
project. The Cloud project settings screen shows the suffix and can rotate or
issue the plaintext key for SDK configuration.
