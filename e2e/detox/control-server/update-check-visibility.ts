export type UpdateCheckVisibilityInput = {
  readonly appBaseUrl: string;
  readonly disabled?: boolean;
  readonly rollout?: number;
  readonly targetCohorts?: readonly string[];
};

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
