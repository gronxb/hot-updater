import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execa: vi.fn(),
  select: vi.fn(),
}));

vi.mock("execa", () => ({
  execa: mocks.execa,
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    p: {
      ...actual.p,
      select: mocks.select,
    },
  };
});

import { resolveFirebaseRegion } from "./firebaseRegion";

describe("resolveFirebaseRegion", () => {
  it("reuses a saved region without running discovery or prompting", async () => {
    // Given
    const options = {
      cwd: "/tmp/firebase-init",
      savedRegion: "asia-northeast3",
    };

    // When
    const region = await resolveFirebaseRegion(options);

    // Then
    expect(region).toBe("asia-northeast3");
    expect(mocks.execa).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("does not run discovery or prompt when a non-interactive region is missing", async () => {
    // Given
    const options = {
      cwd: "/tmp/firebase-init",
      nonInteractive: true,
    };

    // When
    const resolveRegion = resolveFirebaseRegion(options);

    // Then
    await expect(resolveRegion).rejects.toMatchObject({
      missingInputs: ["HOT_UPDATER_FIREBASE_REGION"],
    });
    expect(mocks.execa).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
  });
});
