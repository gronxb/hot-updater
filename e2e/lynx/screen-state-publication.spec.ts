import { describe, expect, it, vi } from "vitest";

import { publishScreenStatePatch } from "../../examples/lynx/src/e2eApp/screenStatePublication";

const response = (
  status: number,
  marker?: string,
  launchGeneration?: string,
) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => ({
    launchGeneration,
    screenState: { runtimeScenarioMarker: marker },
  }),
});

describe("Lynx E2E screen-state publication", () => {
  it("retries a canceled Android marker POST until the exact marker is acknowledged", async () => {
    const fetchState = vi
      .fn()
      .mockResolvedValueOnce(response(499))
      .mockResolvedValueOnce(response(200, "actual-bundle-marker"));

    await publishScreenStatePatch(
      fetchState,
      "http://control.test/e2e/screen-state",
      { runtimeScenarioMarker: "actual-bundle-marker" },
      { retryDelayMs: 0 },
    );

    expect(fetchState).toHaveBeenCalledTimes(2);
  });

  it("requires marker acknowledgement from the active launch generation", async () => {
    const fetchState = vi
      .fn()
      .mockResolvedValue(response(200, "actual-bundle-marker", "launch-old"));

    await expect(
      publishScreenStatePatch(
        fetchState,
        "http://control.test/e2e/screen-state",
        { runtimeScenarioMarker: "actual-bundle-marker" },
        {
          launchGeneration: "launch-new",
          markerAttempts: 2,
          retryDelayMs: 0,
        },
      ),
    ).rejects.toThrow("Screen state marker was not acknowledged");
    expect(fetchState).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchState.mock.calls[0]![1].body as string)).toEqual({
      launchGeneration: "launch-new",
      runtimeScenarioMarker: "actual-bundle-marker",
    });
  });

  it("rejects success responses that do not acknowledge the actual bundle marker", async () => {
    const fetchState = vi
      .fn()
      .mockResolvedValue(response(200, "stale-bundle-marker"));

    await expect(
      publishScreenStatePatch(
        fetchState,
        "http://control.test/e2e/screen-state",
        { runtimeScenarioMarker: "actual-bundle-marker" },
        { markerAttempts: 2, retryDelayMs: 0 },
      ),
    ).rejects.toThrow("Screen state marker was not acknowledged");
    expect(fetchState).toHaveBeenCalledTimes(2);
  });

  it("does not retry ordinary screen-state failures", async () => {
    const fetchState = vi.fn().mockResolvedValue(response(499));

    await expect(
      publishScreenStatePatch(
        fetchState,
        "http://control.test/e2e/screen-state",
        { updateActionResult: "checking" },
      ),
    ).rejects.toThrow("Screen state HTTP 499");
    expect(fetchState).toHaveBeenCalledOnce();
  });
});
