/**
 * What a client plugin imports: `defineClientPlugin` and the types of its
 * context, hooks, and their payloads. It loads neither React Native nor the
 * native module, so a plugin's tests run in plain Node with
 * `@hot-updater/test-utils/react-native`. The root entry exports the same
 * names for the app.
 */
export * from "./clientPlugin";
