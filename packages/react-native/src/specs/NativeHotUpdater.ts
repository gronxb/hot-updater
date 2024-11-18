import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

interface Spec extends TurboModule {
  reload(): void;
  updateBundle(bundleId: string, zipUrl: string): Promise<boolean>;
  getAppVersion(): Promise<string | null>;
}

export default TurboModuleRegistry.get<Spec>("HotUpdater");
