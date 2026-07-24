import { join } from "node:path";

import {
  provisionApiKey,
  type ProvisionedApiKey,
} from "@hot-updater/api-key/provisioning";

const HOT_UPDATER_ENV_FILE = ".env.hotupdater";

export const createManagedAppSnippet = (
  source: string,
): string => `// add this to your App.tsx
import { HotUpdater } from "@hot-updater/react-native";

function App() {
  return ...
}

export default HotUpdater.wrap({
  baseURL: ${JSON.stringify(source)},
  // This client access key is extractable from the app bundle.
  // Do not use it as an administrator secret.
  requestHeaders: {
    "x-api-key": process.env.HOT_UPDATER_API_KEY!,
  },
  updateStrategy: "appVersion", // or "fingerprint"
})(App);`;

export const provisionManagedApiKey = (
  cwd: string,
): Promise<ProvisionedApiKey> =>
  provisionApiKey({ envFilePath: join(cwd, HOT_UPDATER_ENV_FILE) });

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
