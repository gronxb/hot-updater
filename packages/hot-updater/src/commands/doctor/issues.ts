import type { FingerprintChanges } from "../../utils/fingerprint/diff";

export type DoctorFixability = "auto" | "command" | "blocked";
export type NativePlatform = "ios" | "android";

export interface NativeCheckIssue {
  type: "error" | "warning";
  platform: NativePlatform | "project";
  /** Integration-specific codes are reported alongside common native findings. */
  code: string;
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
    | "RELEASE_CATALOG_CHECK_FAILED"
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
  /**
   * `missing`: the scope has releases and no catalog row. `unchecked`: core
   * could not compile it.
   */
  state: "verified" | "stale" | "missing" | "unchecked";
  /** The stored catalog's generation; null without a catalog row. */
  generation: number | null;
  /** The catalog its releases compile to; null when core could not compile it. */
  byteSize: number | null;
  descriptorCount: number | null;
}

/** Every scope with a release catalog, checked without writing. */
export interface ReleaseCatalogStatus {
  scopes: ReleaseCatalogScopeStatus[];
  issues: ReleaseCatalogIssue[];
}

/** A finding about the server's artifact records. */
export interface ArtifactIssue {
  type: "error" | "warning";
  code: "UNREFERENCED_ARTIFACTS" | "ARTIFACTS_UNCHECKED";
  /** UNREFERENCED_ARTIFACTS: the artifact records no release uses. */
  artifactIds?: string[];
  message: string;
  resolution: string;
  fixability: DoctorFixability;
  commands?: string[];
}

/** The server's artifact records against the releases that use them. */
export interface ArtifactStatus {
  /** The artifact records no release uses, by ID. */
  unreferenced: string[];
  issues: ArtifactIssue[];
}

/** An issue a repair can name. */
export type DoctorIssueCode =
  | NativeCheckIssue["code"]
  | ReleaseCatalogIssue["code"]
  | ArtifactIssue["code"];

/** A repair `doctor --fix` ran, with everything it wrote. */
export interface DoctorFix {
  readonly repair:
    | "fingerprint"
    | "public-key"
    | "orphan-public-key"
    | "release-catalogs"
    | "unreferenced-artifacts";
  /** The issue codes it repairs. */
  readonly codes: readonly DoctorIssueCode[];
  readonly status: "applied" | "skipped" | "failed";
  /** The files it wrote, or the catalogs and artifact records it changed. */
  readonly wrote: readonly string[];
  /** It wrote native files, which only a native rebuild picks up. */
  readonly native: boolean;
  /** Why it was skipped, how it failed, or what to know after it applied. */
  readonly note?: string;
}

/** Whether a repair wrote native files, which only a native rebuild picks up. */
export const fixesWroteNativeFiles = (fixes: readonly DoctorFix[]): boolean =>
  fixes.some(({ native, status }) => native && status === "applied");
