import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

export interface UpdateBundleParams {
  bundleId: string;
  fileUrl: string | null;
  /**
   * SHA256 hash of the bundle file for integrity verification.
   * If provided, the native layer will verify the downloaded file's hash.
   */
  fileHash: string | null;
}

export interface Spec extends TurboModule {
  // Methods
  reload(): Promise<void>;
  updateBundle(params: UpdateBundleParams): Promise<boolean>;

  // EventEmitter
  addListener(eventName: string): void;
  removeListeners(count: number): void;
  readonly getConstants: () => {
    MIN_BUNDLE_ID: string;
    APP_VERSION: string | null;
    CHANNEL: string;
    FINGERPRINT_HASH: string | null;
  };
}

export default TurboModuleRegistry.getEnforcing<Spec>("HotUpdater");
