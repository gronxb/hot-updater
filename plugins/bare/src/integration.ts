import type { InitIntegrationDescriptor } from "@hot-updater/cli-tools";

export const initIntegration = {
  schemaVersion: 1,
  id: "bare",
  label: "Bare",
  hint: "React Native CLI",
  dependencies: ["@hot-updater/react-native"],
  devDependencies: ["dotenv"],
  build: {
    imports: [{ pkg: "@hot-updater/bare", named: ["bare"] }],
    configString: "bare({ enableHermes: true })",
  },
} satisfies InitIntegrationDescriptor;
