import type { ReleaseCatalogMutationResult } from "./releaseCatalogMutation";

/** The release fields a policy change may set. */
export interface ReleasePolicyPatch {
  readonly enabled?: boolean;
  readonly fingerprintHash?: string;
  readonly message?: string | null;
  readonly rolloutCohortCount?: number;
  readonly shouldForceUpdate?: boolean;
  readonly targetAppVersion?: string;
  readonly targetCohorts?: readonly string[];
}

export class ReleaseManagementError extends Error {
  readonly name = "ReleaseManagementError";

  constructor(
    readonly code:
      | "ENABLED_RELEASE"
      | "RELEASE_NOT_FOUND"
      | "SCOPE_MOVE_UNSUPPORTED"
      | "TARGET_RELEASE_INVALID"
      | "VERSION_CONFLICT",
    message: string,
  ) {
    super(message);
  }
}

export interface PromoteReleaseResult {
  /** The source release after a move, or null for a copy. */
  readonly source: ReleaseCatalogMutationResult | null;
  readonly target: ReleaseCatalogMutationResult;
}
