/** One place a native project declares its app version. */
export interface AppVersionCandidate {
  /** Where the version was read, such as an Xcode target or a Gradle flavor. */
  label: string;
  /** null when the value is not a literal (a variable or build setting). */
  version: string | null;
}

/**
 * The app version a native project builds. `version` is null when nothing
 * declares one, or when `candidates` disagree: the project builds several
 * apps (targets, flavors) and the version depends on which one is built.
 */
export interface ResolvedAppVersion {
  version: string | null;
  candidates: AppVersionCandidate[];
}

/** One version only when every candidate declares the same literal. */
export const resolveFromCandidates = (
  candidates: AppVersionCandidate[],
): ResolvedAppVersion => {
  const versions = new Set(candidates.map((candidate) => candidate.version));
  const [version] = versions;
  return {
    version: versions.size === 1 && version ? version : null,
    candidates,
  };
};

/** Several candidates and no single version: the caller must pick one. */
export const isAmbiguousAppVersion = ({
  version,
  candidates,
}: ResolvedAppVersion): boolean => version === null && candidates.length > 1;

export const formatAppVersionCandidates = (
  candidates: AppVersionCandidate[],
): string =>
  candidates
    .map(({ label, version }) => `${label}: ${version ?? "unresolved"}`)
    .join(", ");
