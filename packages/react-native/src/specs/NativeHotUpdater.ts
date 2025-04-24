import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

interface Spec extends TurboModule {
  // Methods
  reload(): void;
  updateBundle(bundleId: string, zipUrl: string): Promise<boolean>;
  /**
   * @deprecated
   * use getConstants().APP_VERSION instead
   */
  getAppVersion(): Promise<string | null>;

  setChannel(channel: string): Promise<void>;

  getExecutionCount(): Promise<number>;
  updateExecutionCount(): void;

  // EventEmitter
  addListener(eventName: string): void;
  removeListeners(count: number): void;
  readonly getConstants: () => {
    MIN_BUNDLE_ID: string;
    APP_VERSION: string | null;
    CHANNEL: string | null;
  };
}

export default TurboModuleRegistry.get<Spec>("HotUpdater");
