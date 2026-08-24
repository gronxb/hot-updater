import { describe, expect, it, vi } from "vitest";

import type { SupabaseApi } from "./supabaseApi";
import {
  assertSupabaseFunctionCanInitialize,
  assertSupabaseInfrastructureCanInitialize,
} from "./supabaseInfrastructureState";

const api = (state: "fresh" | "incompatible" | "v1") =>
  ({
    getInfrastructureState: vi.fn().mockResolvedValue(state),
  }) as unknown as SupabaseApi;

describe("Supabase infrastructure generation", () => {
  it.each(["fresh", "v1"] as const)("allows %s projects", async (state) => {
    await expect(
      assertSupabaseInfrastructureCanInitialize(api(state), "project-ref"),
    ).resolves.toBeUndefined();
  });

  it("blocks an incompatible v1 namespace", async () => {
    await expect(
      assertSupabaseInfrastructureCanInitialize(
        api("incompatible"),
        "project-ref",
      ),
    ).rejects.toThrow(
      "Supabase v1 infrastructure in project project-ref is incomplete or uses an unsupported database version.",
    );
  });

  it("allows an unused Edge Function name", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      assertSupabaseFunctionCanInitialize({
        fetchImpl,
        functionName: "update-server",
        functionSlugs: ["unrelated"],
        projectId: "project-ref",
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks an existing v0 Edge Function", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 404 }));

    await expect(
      assertSupabaseFunctionCanInitialize({
        fetchImpl,
        functionName: "update-server",
        functionSlugs: ["update-server"],
        projectId: "project-ref",
      }),
    ).rejects.toThrow(
      "Supabase v0 infrastructure was detected at Edge Function update-server",
    );
  });

  it("allows an existing v1 Edge Function", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ infrastructureGeneration: 1, version: "1.0.0" }),
      );

    await expect(
      assertSupabaseFunctionCanInitialize({
        fetchImpl,
        functionName: "update-server",
        functionSlugs: ["update-server"],
        projectId: "project-ref",
      }),
    ).resolves.toBeUndefined();
  });
});
