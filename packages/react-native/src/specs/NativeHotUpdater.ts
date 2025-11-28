import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

export interface UpdateBundleParams {
  bundleId: string;
  fileUrl: string | null;
  /**
   * File hash for integrity/signature verification.
   *
   * Format depends on signing configuration:
   * - Signed: `sig:<base64_signature>` - Native will verify signature (and implicitly hash)
   * - Unsigned: `<hex_hash>` - Native will verify SHA256 hash only
   *
   * Native determines verification mode by checking for "sig:" prefix.
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
