import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
  log: {
    info: vi.fn(),
    success: vi.fn(),
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

import type { SupabaseApi } from "./supabaseApi";
import {
  ensureSupabaseBucketPrivate,
  PublicSupabaseBucketError,
} from "./supabaseBucketPrivacy";

const createApi = (): SupabaseApi => ({
  createBucket: vi.fn(),
  listLegacyBundlePolicies: vi.fn().mockResolvedValue([]),
  listBuckets: vi.fn(),
  updateBucket: vi.fn(),
});

describe("ensureSupabaseBucketPrivate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.confirm.mockResolvedValue(true);
  });

  it("makes an existing public bucket private after confirmation", async () => {
    // Given
    const api = createApi();

    // When
    await ensureSupabaseBucketPrivate({
      api,
      nonInteractive: false,
      selection: {
        create: false,
        id: "bucket-id",
        isPublic: true,
        name: "bundles",
      },
    });

    // Then
    expect(api.updateBucket).toHaveBeenCalledWith("bucket-id", {
      public: false,
    });
  });

  it("does not prompt for an existing private bucket", async () => {
    // Given
    const api = createApi();

    // When
    await ensureSupabaseBucketPrivate({
      api,
      nonInteractive: false,
      selection: {
        create: false,
        id: "bucket-id",
        isPublic: false,
        name: "bundles",
      },
    });

    // Then
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(api.updateBucket).not.toHaveBeenCalled();
  });

  it("requires an explicit change before replaying a public bucket", async () => {
    // Given
    const api = createApi();

    // When
    const privacy = ensureSupabaseBucketPrivate({
      api,
      nonInteractive: true,
      selection: {
        create: false,
        id: "bucket-id",
        isPublic: true,
        name: "bundles",
      },
    });

    // Then
    await expect(privacy).rejects.toBeInstanceOf(PublicSupabaseBucketError);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
});
