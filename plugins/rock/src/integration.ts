import type { InitIntegrationDescriptor } from "@hot-updater/cli-tools";

export const initIntegration = {
  schemaVersion: 1,
  id: "rock",
  label: "Rock",
  hint: "React Native Enterprise Framework by Callstack",
  dependencies: ["@hot-updater/react-native"],
  devDependencies: ["dotenv"],
  build: {
    imports: [{ pkg: "@hot-updater/rock", named: ["rock"] }],
    configString: "rock()",
  },
} satisfies InitIntegrationDescriptor;
