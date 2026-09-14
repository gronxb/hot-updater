type ScreenStatePatch = {
  readonly runtimeScenarioMarker?: string | null;
  readonly [key: string]: unknown;
};

type ScreenStateResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText?: string;
  readonly json: () => Promise<unknown>;
};

type ScreenStateFetch = (
  url: string,
  init: RequestInit,
) => Promise<ScreenStateResponse>;

const wait = (durationMs: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, durationMs));

const acknowledgedMarker = (payload: unknown): unknown => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const screenState = (payload as { screenState?: unknown }).screenState;
  if (
    !screenState ||
    typeof screenState !== "object" ||
    Array.isArray(screenState)
  ) {
    return undefined;
  }
  return (screenState as { runtimeScenarioMarker?: unknown })
    .runtimeScenarioMarker;
};

const acknowledgedLaunchGeneration = (payload: unknown): unknown => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  return (payload as { launchGeneration?: unknown }).launchGeneration;
};

export async function publishScreenStatePatch(
  fetchState: ScreenStateFetch,
  url: string,
  patch: ScreenStatePatch,
  options: {
    readonly launchGeneration?: string | null;
    readonly markerAttempts?: number;
    readonly retryDelayMs?: number;
  } = {},
): Promise<void> {
  const expectedMarker = patch.runtimeScenarioMarker;
  const requireMarkerAcknowledgement = typeof expectedMarker === "string";
  const attempts = requireMarkerAcknowledgement
    ? (options.markerAttempts ?? 5)
    : 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchState(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...patch,
          ...(options.launchGeneration
            ? { launchGeneration: options.launchGeneration }
            : {}),
        }),
      });
      if (!response.ok) {
        const statusText = response.statusText?.trim();
        throw new Error(
          `Screen state HTTP ${response.status}${statusText ? `: ${statusText}` : ""}`,
        );
      }
      if (requireMarkerAcknowledgement) {
        const payload = await response.json();
        if (
          acknowledgedMarker(payload) !== expectedMarker ||
          (options.launchGeneration &&
            acknowledgedLaunchGeneration(payload) !== options.launchGeneration)
        ) {
          throw new Error("Screen state marker was not acknowledged");
        }
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await wait(options.retryDelayMs ?? 250);
      }
    }
  }

  throw lastError;
}
