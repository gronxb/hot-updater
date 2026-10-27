import type { NativeBuildRow } from "@hot-updater/plugin-core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getReleaseNativeBuild } from "@/lib/api-rpc";

import { ReleaseNativeBuildLink } from "./ReleaseNativeBuildLink";

vi.mock("@/lib/api-rpc", () => ({ getReleaseNativeBuild: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    params,
    search,
  }: {
    children: ReactNode;
    params?: { buildId: string };
    search?: { channel: string };
  }) => (
    <a
      href={
        params === undefined
          ? `/native-builds?channel=${search?.channel}`
          : `/native-builds/${params.buildId}`
      }
    >
      {children}
    </a>
  ),
}));

const read = vi.mocked(getReleaseNativeBuild);

const build = {
  id: "019a0000-0000-7000-8000-00000000b001",
  platform: "android",
  artifact_kind: "apk",
  min_bundle_id: "019a0000-0000-7000-8000-0000000000a0",
} as NativeBuildRow;

const renderLink = (
  release: Parameters<typeof ReleaseNativeBuildLink>[0]["release"],
  patchBases: readonly string[] = [],
) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ReleaseNativeBuildLink
        bundle={{
          patches: patchBases.map((baseBundleId) => ({
            baseBundleId,
            baseFileHash: "base",
            byteSize: 1,
            patchFileHash: "patch",
            patchStorageUri: "s3://patch",
          })),
        }}
        channel="production"
        release={release}
      />
    </QueryClientProvider>,
  );

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ReleaseNativeBuildLink", () => {
  it("links a fingerprint release to its scope's build, and marks a patch from it", async () => {
    read.mockResolvedValue(build);
    renderLink(
      {
        platform: "android",
        fingerprint_hash: "fp-a",
        target_app_version: null,
        bundle_id: "019a0000-0000-7000-8000-0000000000a5",
      },
      [build.min_bundle_id],
    );

    expect(
      (await screen.findByRole("link", { name: /Android APK/ })).getAttribute(
        "href",
      ),
    ).toBe(`/native-builds/${build.id}`);
    expect(screen.getByText("Patches from it")).toBeTruthy();
    expect(read).toHaveBeenCalledWith({
      data: {
        platform: "android",
        channel: "production",
        fingerprintHash: "fp-a",
        targetAppVersion: null,
      },
    });
  });

  it("says when the bundle has no patch from the build", async () => {
    read.mockResolvedValue(build);
    renderLink(
      {
        platform: "android",
        fingerprint_hash: null,
        target_app_version: "1.4.2",
        bundle_id: "019a0000-0000-7000-8000-0000000000a5",
      },
      ["019a0000-0000-7000-8000-0000000000a1"],
    );

    expect(await screen.findByText("No patch from it")).toBeTruthy();
  });

  it("leads to the channel's builds when the scope has none", async () => {
    read.mockResolvedValue(null);
    renderLink({
      platform: "android",
      fingerprint_hash: "fp-a",
      target_app_version: null,
      bundle_id: "019a0000-0000-7000-8000-0000000000a5",
    });

    expect(
      (
        await screen.findByRole("link", { name: "This channel's builds" })
      ).getAttribute("href"),
    ).toBe("/native-builds?channel=production");
  });

  it("shows no build and reads nothing for an app version range", () => {
    for (const target_app_version of ["1.4.x", ">=1.0.0", "1.4"]) {
      renderLink({
        platform: "android",
        fingerprint_hash: null,
        target_app_version,
        bundle_id: "019a0000-0000-7000-8000-0000000000a5",
      });
      cleanup();
    }

    expect(read).not.toHaveBeenCalled();
    expect(screen.queryByText("Native build")).toBeNull();
  });
});
