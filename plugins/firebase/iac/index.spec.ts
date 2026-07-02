import { describe, expect, it, vi } from "vitest";

const upsertTelemetryKeyCredential = vi.fn(async () => {});

vi.mock("../src/firebaseTelemetry", () => ({
  createFirebaseTelemetryOperations: vi.fn(() => ({
    upsertTelemetryKeyCredential,
  })),
}));

vi.mock("firebase-admin", () => ({
  default: {
    apps: [],
    firestore: vi.fn(() => ({})),
    initializeApp: vi.fn(() => ({ options: { projectId: "demo-project" } })),
  },
}));

import {
  getFirebaseRuntimeBaseURL,
  seedFirebaseTelemetryKey,
  SOURCE_TEMPLATE,
} from "./index";

describe("Firebase telemetry init seed", () => {
  it("generates a hutk key through Firestore operations", async () => {
    // Given / When
    const issued = await seedFirebaseTelemetryKey("demo-project");

    // Then
    expect(issued.telemetryKey).toMatch(/^hutk_.+/);
    expect(issued.telemetryKey.endsWith(issued.telemetryKeySuffix)).toBe(true);
    expect(upsertTelemetryKeyCredential).toHaveBeenCalledWith(
      {
        keyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        telemetryKeySuffix: issued.telemetryKeySuffix,
      },
      undefined,
    );
  });

  it("prints the plaintext key only in the SDK setup snippet", () => {
    // Given
    const telemetryKey = "hutk_firebase_seed";

    // When
    const runtimeBaseURL = getFirebaseRuntimeBaseURL({
      serviceConfig: {
        uri: "https://us-central1-demo.cloudfunctions.net/hot-updater",
      },
    });

    // When
    const snippet = SOURCE_TEMPLATE.replace(
      "%%source%%",
      runtimeBaseURL,
    ).replace("%%telemetryKey%%", telemetryKey);

    // Then
    expect(snippet).toContain(`baseURL: "${runtimeBaseURL}"`);
    expect(snippet).not.toContain(
      `baseURL: "${runtimeBaseURL}/api/check-update"`,
    );
    expect(snippet).toContain("analytics: {");
    expect(snippet).toContain(`telemetryKey: "${telemetryKey}"`);
  });
});
