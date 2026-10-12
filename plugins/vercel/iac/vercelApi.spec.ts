import { describe, expect, it, vi } from "vitest";

import { createVercelApi, VercelApiError } from "./vercelApi";

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe("Vercel API", () => {
  it("calls the API as the token, in the team", async () => {
    const fetch = vi.fn(async () => respond({ envs: [] }));
    const api = createVercelApi({ fetch, teamId: "team_1", token: "token" });

    await api.listProjectEnv("prj_1");

    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe(
      "https://api.vercel.com/v10/projects/prj_1/env?teamId=team_1",
    );
    expect(init.headers).toEqual({ authorization: "Bearer token" });
  });

  it("throws Vercel's error message", async () => {
    const api = createVercelApi({
      fetch: async () =>
        respond(
          { error: { code: "forbidden", message: "Not authorized" } },
          403,
        ),
      token: "token",
    });

    const error = await api.listTeams().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(VercelApiError);
    expect(error).toMatchObject({ code: "forbidden", status: 403 });
    expect((error as Error).message).toContain("Not authorized");
  });

  it("reads a missing project as undefined", async () => {
    const api = createVercelApi({
      fetch: async () => respond({ error: { code: "not_found" } }, 404),
      teamId: "team_1",
      token: "token",
    });

    expect(await api.getProject("missing")).toBeUndefined();
  });

  it("reads a project's production domains", async () => {
    const api = createVercelApi({
      fetch: async () =>
        respond({
          id: "prj_1",
          name: "hot-updater",
          targets: { production: { alias: ["hot-updater.vercel.app"] } },
        }),
      token: "token",
    });

    expect(await api.getProject("hot-updater")).toEqual({
      id: "prj_1",
      name: "hot-updater",
      productionAliases: ["hot-updater.vercel.app"],
    });
  });

  it("lists only Blob stores, with their access and project connections", async () => {
    const api = createVercelApi({
      fetch: async () =>
        respond({
          stores: [
            {
              access: "private",
              id: "store_1",
              name: "bundles",
              projectsMetadata: [
                {
                  environmentVariables: ["BLOB_READ_WRITE_TOKEN"],
                  environments: ["production"],
                  id: "spc_1",
                  projectId: "prj_1",
                },
              ],
              region: "iad1",
              type: "blob",
            },
            { id: "store_2", name: "neon", type: "integration" },
          ],
        }),
      token: "token",
    });

    expect(await api.listBlobStores()).toEqual([
      {
        access: "private",
        connections: [
          {
            environmentVariables: ["BLOB_READ_WRITE_TOKEN"],
            environments: ["production"],
            id: "spc_1",
            projectId: "prj_1",
          },
        ],
        id: "store_1",
        name: "bundles",
        region: "iad1",
      },
    ]);
  });

  it("sets an encrypted production variable, replacing one with the same key", async () => {
    const fetch = vi.fn(async () => respond({}));
    const api = createVercelApi({ fetch, teamId: "team_1", token: "token" });

    await api.setProductionEnv("prj_1", "KEY", "value");

    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.searchParams.get("upsert")).toBe("true");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      key: "KEY",
      target: ["production"],
      type: "encrypted",
      value: "value",
    });
  });

  it("connects a store to production with init's variable prefix", async () => {
    const fetch = vi.fn(async () => respond({}));
    const api = createVercelApi({ fetch, teamId: "team_1", token: "token" });

    await api.connectBlobStore({
      envVarPrefix: "HOT_UPDATER_VERCEL_BLOB",
      projectId: "prj_1",
      storeId: "store_1",
    });

    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/v1/storage/stores/store_1/connections");
    expect(JSON.parse(String(init.body))).toEqual({
      envVarEnvironments: ["production"],
      envVarPrefix: "HOT_UPDATER_VERCEL_BLOB",
      projectId: "prj_1",
    });
  });
});
