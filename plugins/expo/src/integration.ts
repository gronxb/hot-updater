import type { InitIntegrationDescriptor } from "@hot-updater/cli-tools";

export const initIntegration = {
  schemaVersion: 1,
  id: "expo",
  label: "Expo",
  dependencies: ["@hot-updater/react-native"],
  devDependencies: ["dotenv"],
  build: {
    imports: [{ pkg: "@hot-updater/expo", named: ["expo"] }],
    configString: "expo()",
  },
} satisfies InitIntegrationDescriptor;
