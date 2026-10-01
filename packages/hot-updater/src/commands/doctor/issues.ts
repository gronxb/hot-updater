import type { FingerprintChanges } from "../../utils/fingerprint/diff";
import type { SigningConfigIssue } from "../../utils/signing/validateSigningConfig";

export type DoctorFixability = "auto" | "command" | "blocked";
export type NativePlatform = "ios" | "android";

export interface NativeCheckIssue {
  type: "error" | "warning";
  platform: NativePlatform | "project";
  code:
    | "NATIVE_FILES_NOT_FOUND"
    | "APP_DELEGATE_NOT_FOUND"
    | "MAIN_APPLICATION_NOT_FOUND"
    | "MISSING_IOS_BUNDLE_PROVIDER"
    | "MISSING_ANDROID_BUNDLE_PROVIDER"
    | "MISSING_FINGERPRINT_JSON"
    | "MISSING_FINGERPRINT_HASH"
    | "FINGERPRINT_HASH_MISMATCH"
    | "FINGERPRINT_JSON_STALE"
    | "FINGERPRINT_GENERATION_FAILED"
    | "MISSING_CLIENT_PLUGIN"
    | "CLIENT_PLUGINS_UNCHECKED"
    | SigningConfigIssue["code"];
  message: string;
  resolution: string;
  fixability: DoctorFixability;
  commands?: string[];
  paths?: string[];
  /** FINGERPRINT_JSON_STALE: the sources that changed since fingerprint.json. */
  changes?: FingerprintChanges;
}

/** A repair `doctor --fix` ran, with every file it wrote. */
export interface DoctorFix {
  readonly repair: "fingerprint" | "public-key" | "orphan-public-key";
  /** The issue codes it repairs. */
  readonly codes: readonly NativeCheckIssue["code"][];
  readonly status: "applied" | "skipped" | "failed";
  /** The files it wrote. */
  readonly wrote: readonly string[];
  /** It writes native files, which only a native rebuild picks up. */
  readonly native: boolean;
  /** Why it was skipped, how it failed, or what to know after it applied. */
  readonly note?: string;
}

/** Whether a repair wrote native files, which only a native rebuild picks up. */
export const fixesWroteNativeFiles = (fixes: readonly DoctorFix[]): boolean =>
  fixes.some(
    ({ native, status, wrote }) =>
      native && status === "applied" && wrote.length > 0,
  );
