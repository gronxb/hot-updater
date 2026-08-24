import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  log: {
    warn: vi.fn(),
  },
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    p: mocks,
  };
});

import { preserveSupabaseBucketPrivacy } from "./supabaseBucketPrivacy";

describe("preserveSupabaseBucketPrivacy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves an existing public bucket for v0 apps", () => {
    preserveSupabaseBucketPrivacy({
      selection: {
        create: false,
        id: "bucket-id",
        isPublic: true,
        name: "bundles",
      },
    });

    expect(mocks.log.warn).toHaveBeenCalledWith(
      'Bucket "bundles" is public. Its access level will be preserved for existing apps.',
    );
  });

  it("does not warn for an existing private bucket", () => {
    preserveSupabaseBucketPrivacy({
      selection: {
        create: false,
        id: "bucket-id",
        isPublic: false,
        name: "bundles",
      },
    });

    expect(mocks.log.warn).not.toHaveBeenCalled();
  });
});
