import { beforeEach, describe, expect, it, vi } from "vitest";

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
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it("rejects an unsafe saved region before running a command", async () => {
    const resolveRegion = resolveFirebaseRegion({
      cwd: "/tmp/firebase-init",
      nonInteractive: true,
      savedRegion: "us-central1; touch /tmp/injected",
    });

    await expect(resolveRegion).rejects.toMatchObject({
      missingInputs: ["HOT_UPDATER_FIREBASE_REGION"],
    });
    expect(mocks.execa).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("prompts without discovery for a project that has not been created", async () => {
    mocks.select.mockResolvedValue("asia-northeast3");

    await expect(
      resolveFirebaseRegion({
        cwd: "/tmp/firebase-init",
        discoverExistingProject: false,
      }),
    ).resolves.toBe("asia-northeast3");
    expect(mocks.execa).not.toHaveBeenCalled();
    expect(mocks.select).toHaveBeenCalledOnce();
  });
});
