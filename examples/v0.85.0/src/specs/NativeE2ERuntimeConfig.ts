import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

export interface Spec extends TurboModule {
  getAppBaseUrl: () => string | null;
  getChannelNamespace: () => string | null;
}

export default TurboModuleRegistry.get<Spec>("E2ERuntimeConfig");
