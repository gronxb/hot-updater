import { describe, expect, it, vi } from "vitest";

import {
  assertFirebaseFunctionCanInitialize,
  resolveFirebaseInfrastructureState,
} from "./firebaseInfrastructureState";

describe("Firebase infrastructure generation", () => {
  it.each([
    [{ adapterVersion: undefined, hasData: false }, "fresh"],
    [{ adapterVersion: 1, hasData: true }, "v0"],
    [{ adapterVersion: 3, hasData: false }, "v0"],
    [{ adapterVersion: undefined, hasData: true }, "v0"],
    [{ adapterVersion: 4, hasData: true }, "v1"],
  ] as const)("classifies %j as %s", (input, expected) => {
    expect(resolveFirebaseInfrastructureState(input)).toBe(expected);
  });

  it("allows a project without the managed function", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      assertFirebaseFunctionCanInitialize({
        fetchImpl,
        functions: [{ id: "unrelated" }],
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks an existing v0 function", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 404 }));

    await expect(
      assertFirebaseFunctionCanInitialize({
        fetchImpl,
        functions: [
          { id: "hot-updater", uri: "https://hot-updater.example.com" },
        ],
      }),
    ).rejects.toThrow(
      "Firebase v0 infrastructure was detected at Function hot-updater",
    );
  });

  it("allows an existing v1 function", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ infrastructureGeneration: 1, version: "1.0.0" }),
      );

    await expect(
      assertFirebaseFunctionCanInitialize({
        fetchImpl,
        functions: [
          { id: "hot-updater", uri: "https://hot-updater.example.com" },
        ],
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://hot-updater.example.com/version",
    );
  });
});
