import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

interface Spec extends TurboModule {
  reload(): void;
  updateBundle(
    zipUrl: string,
    prefix: string,
    callback: (success: boolean) => void,
  ): Promise<boolean>;
  getBundleVersion(): Promise<string>;
}

export default TurboModuleRegistry.get<Spec>("HotUpdater");
