import type { ReleaseCatalogCompilation } from "./releaseCatalogCompiler";
import type { ReleaseCatalogRow, ReleaseRow } from "./types";

/** One Release Catalog: a channel, platform, and target kind. */
export interface ReleaseCatalogScope {
  readonly channelId: string;
  readonly channelName: string;
  readonly platform: "ios" | "android";
  readonly scopeKey: string;
  readonly strategy: "APP_VERSION" | "FINGERPRINT";
  readonly fingerprintHash: string | null;
}

export interface ReleaseCatalogMutationResult {
  readonly attempts: number;
  readonly catalog: ReleaseCatalogRow;
  readonly release: ReleaseRow | null;
}

export class ReleaseCatalogMutationError extends Error {
  readonly name = "ReleaseCatalogMutationError";

  constructor(
    readonly code:
      | "CATALOG_GENERATION_EXHAUSTED"
      | "CATALOG_IDENTITY_MISSING"
      | "INVALID_SCOPE"
      | "NON_MONOTONIC_RELEASE_ID"
      | "RELEASE_NOT_FOUND"
      | "VERSION_CONFLICT",
    message: string,
  ) {
    super(message);
  }
}

/** What a release change would write, without writing it. */
export interface ReleaseCatalogMutationPreflight {
  readonly catalog: ReleaseCatalogRow;
  readonly currentCatalog: ReleaseCatalogRow | null;
  readonly diagnostics: ReleaseCatalogCompilation["diagnostics"];
  readonly expectedReleaseRevision: number | null;
  readonly release: ReleaseRow | null;
}

export interface ReleaseCatalogRebuildResult {
  readonly attempts: number;
  readonly catalog: ReleaseCatalogRow;
  readonly changed: boolean;
  readonly diagnostics: ReleaseCatalogCompilation["diagnostics"];
}

export interface ReleaseCatalogRebuildPreflight {
  readonly changed: boolean;
  readonly currentCatalog: ReleaseCatalogRow | null;
  readonly diagnostics: ReleaseCatalogCompilation["diagnostics"];
  readonly projectedCatalog: ReleaseCatalogRow;
}
