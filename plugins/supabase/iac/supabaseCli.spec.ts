import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockExeca, mockSuccess } = vi.hoisted(() => ({
  mockExeca: vi.fn(),
  mockSuccess: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    p: {
      ...actual.p,
      log: {
        ...actual.p.log,
        success: mockSuccess,
      },
    },
  };
});

vi.mock("execa", async (importOriginal) => {
  const actual = await importOriginal<typeof import("execa")>();
  return {
    ...actual,
    execa: mockExeca,
  };
});

import { pushDB } from "./supabaseCli";

describe("pushDB", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers migration confirmation prompts during init", async () => {
    // Given
    const workdir = "C:\\hot-updater-supabase-push";
    mockExeca.mockResolvedValue({
      stdout: "Finished supabase db push.",
    });

    // When
    await pushDB(workdir, {});

    // Then
    expect(mockExeca).toHaveBeenCalledWith(
      "npx",
      ["supabase", "db", "push", "--include-all", "--yes"],
      expect.objectContaining({ cwd: workdir }),
    );
    expect(mockSuccess).toHaveBeenCalledWith("DB pushed ✔");
  });
});
