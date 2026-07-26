import { join } from "node:path";

import { provisionManagedBetterAuthApiKey } from "@hot-updater/better-auth/managed/provisioning";

const HOT_UPDATER_ENV_FILE = ".env.hotupdater";

export const createManagedAppSnippet = (
  source: string,
): string => `// add this to your App.tsx
import { createReactNativeAnalytics } from "@hot-updater/analytics/react-native";
import { HotUpdater } from "@hot-updater/react-native";
import { HOT_UPDATER_API_KEY } from "@env";

function App() {
  return null;
}

const baseURL = ${JSON.stringify(source)};
const commonHeaders = Object.freeze({
  "x-api-key": HOT_UPDATER_API_KEY,
});
const analytics = createReactNativeAnalytics({
  baseURL,
  requestHeaders: commonHeaders,
});

export default HotUpdater.wrap({
  baseURL,
  // This client access key is extractable from the app bundle.
  // Do not use it as an administrator secret.
  requestHeaders: commonHeaders,
  onNotifyAppReady: (result) => {
    analytics.recordAppReady(result);
  },
  updateStrategy: "appVersion", // or "fingerprint"
})(App);`;

export const provisionManagedApiKey = (cwd: string) =>
  provisionManagedBetterAuthApiKey({
    envFilePath: join(cwd, HOT_UPDATER_ENV_FILE),
  });

export const createManagedWorkerVariables = ({
  apiKeySha256,
  jwtSecret,
}: {
  readonly apiKeySha256: string;
  readonly jwtSecret: string;
}) =>
  Object.freeze({
    API_KEY_SHA256: apiKeySha256,
    JWT_SECRET: jwtSecret,
  });
