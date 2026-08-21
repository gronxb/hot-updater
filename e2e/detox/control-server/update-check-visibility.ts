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
      readonly actualFileHash: string | null;
      readonly ok: false;
      readonly reason: "file-hash-mismatch";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

export function validateArtifactInfoVisibility(
  payload: unknown,
  expectedFileHash: string | null,
): ArtifactInfoVisibilityValidation {
  if (
    !isRecord(payload) ||
    !isNullableString(payload.fileHash) ||
    !isNullableString(payload.fileUrl) ||
    (payload.manifestFileHash !== undefined &&
      !isNullableString(payload.manifestFileHash)) ||
    (payload.manifestUrl !== undefined &&
      !isNullableString(payload.manifestUrl)) ||
    (payload.changedAssets !== undefined &&
      payload.changedAssets !== null &&
      !isRecord(payload.changedAssets))
  ) {
    return { ok: false, reason: "invalid-artifact-info" };
  }

  if (payload.fileHash !== expectedFileHash) {
    return {
      actualFileHash: payload.fileHash,
      ok: false,
      reason: "file-hash-mismatch",
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
