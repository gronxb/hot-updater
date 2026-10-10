import { InitError } from "@hot-updater/cli-tools";
import { describe, expect, it, vi } from "vitest";

import {
  assertFirebaseFunctionCanInitialize,
  resolveFirebaseInfrastructureState,
} from "./firebaseInfrastructureState";

describe("Firebase infrastructure generation", () => {
  it.each([
    [{ engine: undefined, preEngineData: false }, "fresh"],
    [{ engine: "1", preEngineData: false }, "v1"],
    [{ engine: "2", preEngineData: false }, "incompatible"],
    [{ engine: undefined, preEngineData: true }, "incompatible"],
    [{ engine: "1", preEngineData: true }, "incompatible"],
  ] as const)("classifies %j as %s", (input, expected) => {
    expect(resolveFirebaseInfrastructureState(input)).toBe(expected);
  });

  it("ignores functions with other names", async () => {
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

  it.each([
    ["answers 404 at /version", new Response(null, { status: 404 })],
    [
      "reports no infrastructure generation",
      Response.json({ version: "1.0.0" }),
    ],
  ])(
    "blocks an incompatible function occupying the v1 name, which %s",
    async (_, response) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);

      const blocked = assertFirebaseFunctionCanInitialize({
        fetchImpl,
        functions: [
          {
            id: "hot-updater-v1",
            uri: "https://hot-updater-v1.example.com",
          },
        ],
      });

      await expect(blocked).rejects.toBeInstanceOf(InitError);
      await expect(blocked).rejects.toThrow(
        "Function hot-updater-v1, which init deploys, already exists in this Firebase project and is incompatible: its /version does not report Hot Updater infrastructure generation 1. Delete the function or use another Firebase project, then rerun init. The existing function was not changed.",
      );
    },
  );

  it("keeps the shared error when the function's /version cannot be read", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 503 }));

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
      "Could not verify the Firebase infrastructure generation at Function hot-updater-v1: HTTP 503",
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
