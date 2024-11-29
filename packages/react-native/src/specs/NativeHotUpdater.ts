import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

interface Spec extends TurboModule {
  // Methods
  reload(): void;
  updateBundle(bundleId: string, zipUrl: string): Promise<boolean>;
  getAppVersion(): Promise<string | null>;

  // EventEmitter
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.get<Spec>("HotUpdater");
