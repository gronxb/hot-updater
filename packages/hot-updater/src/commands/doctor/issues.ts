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

/** A finding about the server's release catalogs, by scope. */
export interface ReleaseCatalogIssue {
  type: "error" | "warning";
  code:
    | "RELEASE_CATALOG_STALE"
    | "RELEASE_CATALOG_IDENTITY_MISSING"
    | "RELEASE_CATALOGS_UNCHECKED";
  /** The scope the issue is about; absent when no catalog could be read. */
  scopeKey?: string;
  message: string;
  resolution: string;
  fixability: DoctorFixability;
  commands?: string[];
}

/** One scope's catalog against a rebuild from its releases. */
export interface ReleaseCatalogScopeStatus {
  scopeKey: string;
  state: "verified" | "stale" | "missing";
  /** The stored catalog's generation; null with no compiled projection. */
  generation: number | null;
  byteSize: number;
  descriptorCount: number;
}

/** Every scope with a release catalog, checked without writing. */
export interface ReleaseCatalogStatus {
  scopes: ReleaseCatalogScopeStatus[];
  issues: ReleaseCatalogIssue[];
}

/** An issue a repair can name. */
export type DoctorIssueCode =
  | NativeCheckIssue["code"]
  | ReleaseCatalogIssue["code"];

/** A repair `doctor --fix` ran, with everything it wrote. */
export interface DoctorFix {
  readonly repair:
    | "fingerprint"
    | "public-key"
    | "orphan-public-key"
    | "release-catalogs";
  /** The issue codes it repairs. */
  readonly codes: readonly DoctorIssueCode[];
  readonly status: "applied" | "skipped" | "failed";
  /** The files, or for release catalogs the catalogs, it wrote. */
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
