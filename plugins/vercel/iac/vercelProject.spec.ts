import { describe, expect, it, vi } from "vitest";

import {
  assertVercelProjectCanHostFunction,
  productionBaseUrl,
} from "./vercelProject";

const project = {
  id: "prj_1",
  name: "hot-updater",
  productionAliases: ["hot-updater-team.vercel.app", "hot-updater.vercel.app"],
};

describe("productionBaseUrl", () => {
  it("prefers the project's own vercel.app domain", () => {
    expect(productionBaseUrl(project)).toBe("https://hot-updater.vercel.app");
  });

  it("falls back to another production domain", () => {
    expect(
      productionBaseUrl({ ...project, productionAliases: ["ota.example.com"] }),
    ).toBe("https://ota.example.com");
    expect(() =>
      productionBaseUrl({ ...project, productionAliases: [] }),
    ).toThrow("no production domain");
  });
});

describe("assertVercelProjectCanHostFunction", () => {
  const api = (deployed: boolean) => ({
    hasProductionDeployment: vi.fn(async () => deployed),
  });

  it("reuses the saved project or one that never deployed to production", async () => {
    const fetchImpl = vi.fn();

    await assertVercelProjectCanHostFunction({
      api: api(true),
      fetchImpl,
      project,
      savedProjectId: "prj_1",
    });
    await assertVercelProjectCanHostFunction({
      api: api(false),
      fetchImpl,
      project,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reuses a project whose production is a Hot Updater server", async () => {
    await assertVercelProjectCanHostFunction({
      api: api(true),
      fetchImpl: async () =>
        Response.json({ infrastructureGeneration: 1, version: "1.0.1" }),
      project,
    });
  });

  it("refuses a project that serves another app", async () => {
    for (const response of [
      new Response("<html>", { status: 200 }),
      new Response("Not Found", { status: 404 }),
      Response.json({ version: "1.0.0" }),
    ]) {
      await expect(
        assertVercelProjectCanHostFunction({
          api: api(true),
          fetchImpl: async () => response,
          project,
        }),
      ).rejects.toThrow("already serves another app");
    }
  });
});
