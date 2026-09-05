import { describe, expect, it, vi } from "vitest";

import {
  assertFirebaseFunctionCanInitialize,
  resolveFirebaseInfrastructureState,
} from "./firebaseInfrastructureState";

describe("Firebase infrastructure generation", () => {
  it.each([
    [{ adapterVersion: undefined, hasData: false }, "fresh"],
    [{ adapterVersion: 1, hasData: true }, "incompatible"],
    [{ adapterVersion: 3, hasData: false }, "incompatible"],
    [{ adapterVersion: undefined, hasData: true }, "incompatible"],
    [{ adapterVersion: 4, hasData: true }, "v1"],
    [{ adapterVersion: 5, hasData: true }, "v1"],
  ] as const)("classifies %j as %s", (input, expected) => {
    expect(resolveFirebaseInfrastructureState(input)).toBe(expected);
  });

  it("ignores the v0 function because v1 has a distinct function name", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      assertFirebaseFunctionCanInitialize({
        fetchImpl,
        functions: [
          { id: "hot-updater", uri: "https://hot-updater.example.com" },
        ],
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks an incompatible function occupying the v1 name", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 404 }));

    await expect(
      assertFirebaseFunctionCanInitialize({
        fetchImpl,
        functions: [
          {
            id: "hot-updater-v1",
            uri: "https://hot-updater-v1.example.com",
          },
        ],
      }),
    ).rejects.toThrow(
      "Firebase v0 infrastructure was detected at Function hot-updater-v1",
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
          {
            id: "hot-updater-v1",
            uri: "https://hot-updater-v1.example.com",
          },
        ],
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://hot-updater-v1.example.com/version",
    );
  });
});
