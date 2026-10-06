import { describe, expect, it } from "vitest";

import { parseBundleEventRequest } from "./eventInput";

const launch = (fields: Record<string, unknown> = {}) =>
  new Request("https://example.com/events", {
    method: "POST",
    body: JSON.stringify({
      type: "UNCHANGED",
      installId: "install-1",
      platform: "ios",
      appVersion: "1.0.0",
      channel: "production",
      cohort: "1",
      fingerprintHash: null,
      sdkVersion: "1.0.0",
      fromBundleId: null,
      fromReleaseId: null,
      toBundleId: "019a0000-0000-7000-8000-000000000000",
      toReleaseId: null,
      updateStrategy: null,
      ...fields,
    }),
  });

describe("parseBundleEventRequest", () => {
  it("reads the native build's built-in bundle ID", async () => {
    await expect(
      parseBundleEventRequest(
        launch({ minBundleId: "019a0000-0000-7000-8000-000000000000" }),
      ),
    ).resolves.toMatchObject({
      minBundleId: "019a0000-0000-7000-8000-000000000000",
    });
  });

  it("records a report without the built-in bundle ID, or with a malformed one", async () => {
    for (const minBundleId of [undefined, null, "", 7, "x".repeat(37)]) {
      await expect(
        parseBundleEventRequest(launch({ minBundleId })),
      ).resolves.toMatchObject({ type: "UNCHANGED", minBundleId: null });
    }
  });
});
