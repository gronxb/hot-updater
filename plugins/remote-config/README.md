# @hot-updater/plugin-remote-config

Hot Updater's Remote Config plugin. The server plugin stores versioned
templates of parameters and conditions, and answers each device with the
values its conditions pick; the client plugin fetches those values in the app
and reads them synchronously, over in-app defaults.

You don't install it on its own. `@hot-updater/server` and
`@hot-updater/react-native` depend on it and re-export it.

For `hot-updater.config.ts`, import the factory from the CLI's plugin entry:

```ts
import { remoteConfig } from "hot-updater/plugins";
```

For the server definition and app, use their runtime entries:

```ts
// The server definition
import { remoteConfig } from "@hot-updater/server/plugins/remote-config";

// The app
import { HotUpdater, remoteConfig } from "@hot-updater/react-native";
```

| Entry      | Re-exported as                                                          |
| ---------- | ----------------------------------------------------------------------- |
| `./server` | `@hot-updater/server/plugins/remote-config`                             |
| `./client` | `remoteConfig` and its types from the `@hot-updater/react-native` root |

See [Remote Config](https://hot-updater.dev/docs/guides/remote-config).
