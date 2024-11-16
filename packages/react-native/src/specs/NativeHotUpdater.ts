import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

interface Spec extends TurboModule {
  reload(): void;
  updateBundle(
    prefix: string,
    zipUrl: string | null,
    callback: (success: boolean) => void,
  ): void;
  getAppVersion(callback: (version: string | null) => void): void;
}

export default TurboModuleRegistry.get<Spec>("HotUpdater");
