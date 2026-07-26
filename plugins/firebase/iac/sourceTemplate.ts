import { transformTemplate } from "@hot-updater/cli-tools";

const SOURCE_TEMPLATE = `// add this to your App.tsx
import { createReactNativeAnalytics } from "@hot-updater/analytics/react-native";
import { HotUpdater } from "@hot-updater/react-native";
import { HOT_UPDATER_API_KEY } from "@env";

// This key is extractable from the app bundle. Treat it as an access gate,
// not as an administrator credential or a user identity.
const baseURL = "%%source%%";
const commonHeaders = Object.freeze({
  "x-api-key": HOT_UPDATER_API_KEY,
});
const analytics = createReactNativeAnalytics({
  baseURL,
  requestHeaders: commonHeaders,
});

function App() {
  return ...
}

export default HotUpdater.wrap({
  baseURL,
  requestHeaders: commonHeaders,
  onNotifyAppReady: (result) => {
    analytics.recordAppReady(result);
  },
  updateStrategy: "appVersion", // or "fingerprint"
})(App);`;

export const renderFirebaseSourceTemplate = (source: string) =>
  transformTemplate(SOURCE_TEMPLATE, { source });
