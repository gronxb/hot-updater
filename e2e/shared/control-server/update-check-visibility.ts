export type UpdateCheckVisibilityInput = {
  readonly appBaseUrl: string;
  readonly disabled?: boolean;
  readonly rollout?: number;
  readonly targetCohorts?: readonly string[];
};

export type ArtifactInfoVisibilityValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "invalid-artifact-info" }
  | {
      readonly actualManifestFileHash: string | null;
      readonly ok: false;
      readonly reason: "manifest-file-hash-mismatch";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateArtifactInfoVisibility(
  payload: unknown,
  expectedManifestFileHash: string,
): ArtifactInfoVisibilityValidation {
  if (
    !isRecord(payload) ||
    payload.artifactProtocolVersion !== 1 ||
    typeof payload.manifestFileHash !== "string" ||
    typeof payload.manifestUrl !== "string" ||
    !isRecord(payload.assets)
  ) {
    return { ok: false, reason: "invalid-artifact-info" };
  }

  if (payload.manifestFileHash !== expectedManifestFileHash) {
    return {
      actualManifestFileHash: payload.manifestFileHash,
      ok: false,
      reason: "manifest-file-hash-mismatch",
    };
  }

  return { ok: true };
}

function isLoopbackHost(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "10.0.2.2" ||
    hostname === "10.0.3.2"
  );
}

function isLocalAppBaseUrl(appBaseUrl: string) {
  try {
    return isLoopbackHost(new URL(appBaseUrl).hostname);
  } catch {
    return false;
  }
}

export function shouldProbeUpdateCheckVisibility(
  input: UpdateCheckVisibilityInput,
) {
  return (
    input.disabled !== true &&
    typeof input.rollout !== "number" &&
    (!input.targetCohorts || input.targetCohorts.length === 0) &&
    isLocalAppBaseUrl(input.appBaseUrl)
  );
}
