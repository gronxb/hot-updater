import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@hot-updater/lynx/navigation", () => ({ navigate: navigateMock }));

const navigationBoundaryPath = path.resolve(
  import.meta.dirname,
  "../../../examples/lynx/spike/navigation-boundary.ts",
);
const {
  navigationBoundaryRequests,
  navigationBoundaryVectors,
  verifyNavigationBoundary,
} = await import(navigationBoundaryPath);

describe("public example navigation boundary", () => {
  beforeEach(() => {
    navigateMock.mockReset();
    navigateMock.mockImplementation((_request, callback) =>
      callback({ code: -1, msg: "rejected" }),
    );
  });

  it("uses the exact max and plus-one vectors exercised by the package", () => {
    const canonical = navigationBoundaryRequests("canonical-options");
    expect(canonical).toEqual({
      accepted: {
        path: "detail.lynx.bundle",
        options: {
          animated: true,
          params: { title: "Second Page", value: "a+b" },
          replace: false,
          useSysBrowser: false,
        },
      },
      rejected: [
        { path: "/detail.lynx.bundle" },
        {
          path: "detail.lynx.bundle",
          options: { params: { url: "detail.lynx.bundle" } },
        },
        { path: "detail.lynx.bundle", options: { replace: true } },
      ],
    });
    expect(
      Object.keys(
        navigationBoundaryRequests("parameter-count").accepted.options!.params!,
      ),
    ).toHaveLength(32);
    expect(
      Object.keys(
        navigationBoundaryRequests("parameter-count").rejected[0]!.options!
          .params!,
      ),
    ).toHaveLength(33);
    expect(
      Buffer.byteLength(
        Object.keys(
          navigationBoundaryRequests("key-bytes").accepted.options!.params!,
        )[0]!,
      ),
    ).toBe(128);
    expect(
      Buffer.byteLength(
        String(
          navigationBoundaryRequests("value-bytes").accepted.options!.params!
            .value,
        ),
      ),
    ).toBe(1_024);
  });

  it("cycles the public vectors only after accepted open and local rejection", async () => {
    const statuses: string[] = [];
    for (const vector of navigationBoundaryVectors) {
      navigateMock
        .mockImplementationOnce((_request, callback) =>
          callback({ code: 1, msg: "ok" }),
        )
        .mockImplementation((_request, callback) =>
          callback({ code: -1, msg: "rejected" }),
        );
      await verifyNavigationBoundary((status: string) => statuses.push(status));
      expect(statuses.at(-1)).toBe(
        `Navigation boundary ${vector}: max accepted, plus one rejected`,
      );
    }
    expect(navigateMock).toHaveBeenCalledTimes(14);
  });
});
