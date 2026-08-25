import type {
  Bundle,
  BundlePatchRow,
  BundleRepository,
  BundleRow,
  DatabaseCommit,
} from "@hot-updater/plugin-core";
import {
  bundleToPatchRows,
  bundleToRow,
  createDatabaseClient,
  rowToBundle,
} from "@hot-updater/plugin-core";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";

import {
  StandaloneDatabaseError,
  standaloneRepository,
  type Routes,
} from "./standaloneRepository";

const BASE_URL = "http://localhost/hot-updater/admin";
const bundles = new Map<string, Bundle>();
const channels = new Set<string>();
const referencedChannels = new Set<string>();
const channelIds = new Map<string, string>();
const requestPaths: string[] = [];
const createRequestBodies: unknown[] = [];

const bundle = (id: string, overrides: Partial<Bundle> = {}): Bundle => {
  const value: Bundle = {
    id,
    platform: "ios",
    fileHash: `hash-${id}`,
    gitCommitHash: null,
    storageUri: `storage://${id}`,
    archiveByteSize: 3_000_000_001,
    ...overrides,
  };
  return value;
};

const server = setupServer(
  http.get(`${BASE_URL}/channels`, ({ request }) => {
    requestPaths.push(new URL(request.url).pathname);
    return HttpResponse.json({
      data: {
        channels: [...channels].map((name) => ({
          id: channelIds.get(name) ?? `channel-${name}`,
          name,
        })),
      },
    });
  }),
  http.post(`${BASE_URL}/channels`, async ({ request }) => {
    requestPaths.push(new URL(request.url).pathname);
    const input = (await request.json()) as {
      row: { id: string; name: string };
      onConflict: "returnExisting";
    };
    const inserted = !channels.has(input.row.name);
    channels.add(input.row.name);
    if (inserted) channelIds.set(input.row.name, input.row.id);
    return HttpResponse.json(
      {
        data: {
          row: {
            id: channelIds.get(input.row.name) ?? `channel-${input.row.name}`,
            name: input.row.name,
          },
          inserted,
        },
      },
      { status: inserted ? 201 : 200 },
    );
  }),
  http.delete(`${BASE_URL}/channels/:id`, ({ params, request }) => {
    requestPaths.push(new URL(request.url).pathname);
    const id = String(params.id);
    const name = id.replace(/^channel-/, "");
    if (!channels.has(name)) {
      return HttpResponse.json(
        { data: { deleted: false, reason: "not_found" } },
        { status: 404 },
      );
    }
    if (referencedChannels.has(name)) {
      return HttpResponse.json(
        { data: { deleted: false, reason: "not_empty" } },
        { status: 409 },
      );
    }
    channels.delete(name);
    channelIds.delete(name);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(`${BASE_URL}/bundles/:id`, ({ params, request }) => {
    requestPaths.push(new URL(request.url).pathname);
    const value = bundles.get(String(params.id));
    return value
      ? HttpResponse.json(value)
      : HttpResponse.json({ error: "Not found" }, { status: 404 });
  }),
  http.get(`${BASE_URL}/bundles`, ({ request }) => {
    requestPaths.push(new URL(request.url).pathname);
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const page = Number(url.searchParams.get("page") ?? 1);
    const all = [...bundles.values()];
    const start = (page - 1) * limit;
    const data = all.slice(start, start + limit);
    return HttpResponse.json({
      data,
      pagination: {
        total: all.length,
        hasNextPage: start + data.length < all.length,
        hasPreviousPage: page > 1,
        currentPage: page,
        totalPages: Math.max(1, Math.ceil(all.length / limit)),
      },
    });
  }),
  http.post(`${BASE_URL}/database/commit`, async ({ request }) => {
    requestPaths.push(new URL(request.url).pathname);
    const input = (await request.json()) as DatabaseCommit;
    createRequestBodies.push(input);
    const staged = new Map(bundles);
    for (const change of input.changes) {
      if (change.model === "bundles") {
        if (change.operation === "insert") {
          staged.set(change.row.id, rowToBundle(change.row));
        } else if (change.operation === "update") {
          const current = staged.get(change.where.id);
          if (!current) {
            return HttpResponse.json({
              data: {
                committed: false,
                conflict: {
                  changeIndex: input.changes.indexOf(change),
                  reason: "not_found",
                },
              },
            });
          }
          staged.set(
            current.id,
            rowToBundle(
              { ...bundleToRow(current), ...change.update } as BundleRow,
              bundleToPatchRows(current),
            ),
          );
        } else {
          staged.delete(change.where.id);
        }
        continue;
      }
      if (change.model !== "bundlePatches") continue;
      if (change.operation === "insert") {
        const current = staged.get(change.row.bundle_id);
        if (!current) {
          return HttpResponse.json({ error: "foreign key" }, { status: 409 });
        }
        staged.set(
          current.id,
          rowToBundle(bundleToRow(current), [
            ...bundleToPatchRows(current),
            change.row,
          ]),
        );
      } else {
        const current = staged.get(change.where.bundleId);
        if (!current) continue;
        staged.set(
          current.id,
          rowToBundle(bundleToRow(current), [] as BundlePatchRow[]),
        );
      }
    }
    bundles.clear();
    for (const [id, value] of staged) bundles.set(id, value);
    return HttpResponse.json({ data: { committed: true } });
  }),
  http.post(`${BASE_URL}/bundles`, async ({ request }) => {
    requestPaths.push(new URL(request.url).pathname);
    const body: unknown = await request.json();
    createRequestBodies.push(body);
    const values = Array.isArray(body) ? body : [body];
    for (const value of values) {
      if (typeof value === "object" && value !== null && "id" in value) {
        const next = value as Bundle;
        bundles.set(next.id, next);
      }
    }
    return HttpResponse.json({ success: true }, { status: 201 });
  }),
  http.patch(`${BASE_URL}/bundles/:id`, async ({ params, request }) => {
    requestPaths.push(new URL(request.url).pathname);
    const id = String(params.id);
    const current = bundles.get(id);
    if (!current) {
      return HttpResponse.json({ error: "Not found" }, { status: 404 });
    }
    const update = (await request.json()) as Partial<Bundle>;
    const next = { ...current, ...update, id };
    bundles.set(id, next);
    return HttpResponse.json({ success: true });
  }),
  http.delete(`${BASE_URL}/bundles/:id`, ({ params, request }) => {
    requestPaths.push(new URL(request.url).pathname);
    bundles.delete(String(params.id));
    return HttpResponse.json({ success: true });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  bundles.clear();
  channels.clear();
  referencedChannels.clear();
  channelIds.clear();
  requestPaths.length = 0;
  createRequestBodies.length = 0;
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const createRepository = (): BundleRepository =>
  standaloneRepository({ baseUrl: BASE_URL });

describe("standaloneRepository", () => {
  it("stays a bundle-only remote repository", () => {
    const repository = createRepository();

    expect(repository.models.bundles.findMany).toBeTypeOf("function");
    expect(repository.models.bundlePatches.findByBundleIds).toBeTypeOf(
      "function",
    );
    expect(repository.commit).toBeTypeOf("function");
    expect(Reflect.has(repository, "analytics")).toBe(false);
    expect(Reflect.has(repository, "apiKeys")).toBe(false);
  });

  it("keeps Channel routing canonical instead of exposing an override", () => {
    expectTypeOf<keyof Routes>().toEqualTypeOf<
      "create" | "update" | "list" | "retrieve" | "delete"
    >();
  });

  it("uses the atomic database commit route for aggregate mutations", async () => {
    const base = bundle("00000000-0000-0000-0000-000000000001");
    const target = bundle("00000000-0000-0000-0000-000000000002", {
      patches: [
        {
          baseBundleId: base.id,
          baseFileHash: base.fileHash,
          patchFileHash: "patch-hash",
          patchStorageUri: "storage://patch",
          byteSize: 3_000_000_002,
        },
      ],
    });
    const client = createDatabaseClient(createRepository());

    await client.insertBundle(base);
    await client.insertBundle(target);

    await expect(client.getBundleById(target.id)).resolves.toMatchObject({
      id: target.id,
      patches: target.patches,
    });
    expect(requestPaths).toContain("/hot-updater/admin/database/commit");
    expect(
      requestPaths.every(
        (path) =>
          path.startsWith("/hot-updater/admin/bundles") ||
          path === "/hot-updater/admin/channels" ||
          path === "/hot-updater/admin/database/commit",
      ),
    ).toBe(true);
  });

  it("replaces bundle patches through the aggregate update route", async () => {
    const base = bundle("00000000-0000-0000-0000-000000000001");
    const target = bundle("00000000-0000-0000-0000-000000000002");
    const client = createDatabaseClient(createRepository());
    await client.insertBundle(base);
    await client.insertBundle(target);

    await client.updateBundleById(target.id, {
      patches: [
        {
          baseBundleId: base.id,
          baseFileHash: base.fileHash,
          patchFileHash: "replacement-patch-hash",
          patchStorageUri: "storage://replacement-patch",
          byteSize: 3_000_000_002,
        },
      ],
    });

    await expect(client.getBundleById(target.id)).resolves.toMatchObject({
      patches: [
        {
          baseBundleId: base.id,
          patchFileHash: "replacement-patch-hash",
        },
      ],
    });
  });

  it("does not publish staged bundle changes when a transaction fails", async () => {
    const target = bundle("00000000-0000-0000-0000-000000000001");
    const client = createDatabaseClient(createRepository());
    await client.insertBundle(target);

    const mutation = client.mutate(async (transaction) => {
      await transaction.updateBundleById(target.id, {
        storageUri: "storage://staged",
      });
      throw new Error("reject transaction");
    });

    await expect(mutation).rejects.toThrow("reject transaction");
    await expect(client.getBundleById(target.id)).resolves.toMatchObject({
      storageUri: target.storageUri,
    });
  });

  it("commits multiple bundle creations in one remote request", async () => {
    const ios = bundle("00000000-0000-0000-0000-000000000001");
    const android = bundle("00000000-0000-0000-0000-000000000002", {
      platform: "android",
    });
    const client = createDatabaseClient(createRepository());

    await client.mutate(async (transaction) => {
      await transaction.insertBundle(ios);
      await transaction.insertBundle(android);
    });

    expect(createRequestBodies).toEqual([
      {
        changes: [
          expect.objectContaining({
            model: "bundles",
            operation: "insert",
            row: expect.objectContaining({ id: ios.id, platform: "ios" }),
          }),
          expect.objectContaining({
            model: "bundles",
            operation: "insert",
            row: expect.objectContaining({
              id: android.id,
              platform: "android",
            }),
          }),
        ],
      },
    ]);
    await expect(client.getBundleById(ios.id)).resolves.toMatchObject({
      id: ios.id,
    });
    await expect(client.getBundleById(android.id)).resolves.toMatchObject({
      id: android.id,
    });
  });

  it("does not retry a bundle batch after an ambiguous commit failure", async () => {
    const first = bundle("00000000-0000-0000-0000-000000000001");
    const second = bundle("00000000-0000-0000-0000-000000000002");
    const client = createDatabaseClient(createRepository());
    server.use(
      http.post(`${BASE_URL}/database/commit`, async ({ request }) => {
        createRequestBodies.push(await request.json());
        return HttpResponse.json(
          { error: "response lost after commit" },
          { status: 500 },
        );
      }),
    );

    const commit = client.mutate(async (transaction) => {
      await transaction.insertBundle(first);
      await transaction.insertBundle(second);
    });

    await expect(commit).rejects.toBeInstanceOf(StandaloneDatabaseError);
    expect(createRequestBodies).toHaveLength(1);
    expect(createRequestBodies[0]).toEqual({
      changes: [
        expect.objectContaining({
          model: "bundles",
          row: expect.objectContaining({ id: first.id }),
        }),
        expect.objectContaining({
          model: "bundles",
          row: expect.objectContaining({ id: second.id }),
        }),
      ],
    });
  });

  it("loads normalized rows through the canonical Channel route", async () => {
    channels.add("preview");
    const repository = createRepository();

    await expect(repository.models.channels.list({})).resolves.toEqual({
      channels: [{ id: "channel-preview", name: "preview" }],
    });
    expect(bundles.size).toBe(0);
    expect(requestPaths).toContain("/hot-updater/admin/channels");
  });

  it("inserts a Channel and returns the server's canonical row", async () => {
    const repository = createRepository();

    await expect(
      repository.models.channels.insert({
        row: { id: "candidate-id", name: "preview" },
        onConflict: "returnExisting",
      }),
    ).resolves.toEqual({
      row: { id: "candidate-id", name: "preview" },
      inserted: true,
    });
    await expect(
      repository.models.channels.insert({
        row: { id: "losing-id", name: "preview" },
        onConflict: "returnExisting",
      }),
    ).resolves.toEqual({
      row: { id: "candidate-id", name: "preview" },
      inserted: false,
    });
  });

  it("rejects an inserted Channel response with a different id", async () => {
    server.use(
      http.post(`${BASE_URL}/channels`, () =>
        HttpResponse.json({
          data: {
            row: { id: "unexpected-id", name: "preview" },
            inserted: true,
          },
        }),
      ),
    );

    await expect(
      createRepository().models.channels.insert({
        row: { id: "candidate-id", name: "preview" },
        onConflict: "returnExisting",
      }),
    ).rejects.toEqual(
      new StandaloneDatabaseError(
        "invalid-response",
        "Invalid Channel insert response.",
        200,
      ),
    );
  });

  it("deletes only an empty Channel through the canonical route", async () => {
    channels.add("preview");
    channels.add("production");
    referencedChannels.add("production");
    const repository = createRepository();

    await expect(
      repository.models.channels.delete({ id: "channel-preview" }),
    ).resolves.toEqual({ deleted: true });
    await expect(
      repository.models.channels.delete({ id: "channel-production" }),
    ).resolves.toEqual({ deleted: false, reason: "not_empty" });
    await expect(
      repository.models.channels.delete({ id: "channel-missing" }),
    ).resolves.toEqual({ deleted: false, reason: "not_found" });
  });

  it("keeps aggregate artifact fields", async () => {
    const value = bundle("00000000-0000-0000-0000-000000000021", {
      storageUri: "storage://preview-artifact",
    });
    bundles.set(value.id, value);

    await expect(
      createRepository().models.bundles.findById(value.id),
    ).resolves.toMatchObject({
      id: value.id,
      storage_uri: "storage://preview-artifact",
    });
  });

  it("uses the configured retrieve route for exact bundle ids", async () => {
    const value = bundle("00000000-0000-0000-0000-000000000022");
    let retrieveCalls = 0;
    server.use(
      http.get(`http://localhost/custom/bundles/${value.id}`, () => {
        retrieveCalls += 1;
        return HttpResponse.json(value);
      }),
      http.get("http://localhost/channels", () =>
        HttpResponse.json({
          data: {
            channels: [{ id: "channel-production", name: "production" }],
          },
        }),
      ),
    );
    const repository = standaloneRepository({
      baseUrl: "http://localhost",
      routes: {
        retrieve: (bundleId) => ({ path: `/custom/bundles/${bundleId}` }),
      },
    });

    await expect(
      repository.models.bundles.findById(value.id),
    ).resolves.toMatchObject({
      id: value.id,
      storage_uri: value.storageUri,
    });
    expect(retrieveCalls).toBe(1);
  });

  it("forwards supported bundle filters and page-aligned offsets", async () => {
    let requestedUrl: URL | undefined;
    server.use(
      http.get(`${BASE_URL}/bundles`, ({ request }) => {
        requestedUrl = new URL(request.url);
        return HttpResponse.json({
          data: [],
          pagination: {
            total: 0,
            hasNextPage: false,
            hasPreviousPage: true,
            currentPage: 3,
            totalPages: 3,
          },
        });
      }),
    );

    await createRepository().models.bundles.findMany({
      where: {
        platform: "ios",
        id: { gte: "bundle-20" },
      },
      orderBy: { field: "id", direction: "desc" },
      limit: 10,
      offset: 20,
    });

    expect(requestedUrl?.searchParams.get("platform")).toBe("ios");
    expect(requestedUrl?.searchParams.has("channel")).toBe(false);
    expect(requestedUrl?.searchParams.has("enabled")).toBe(false);
    expect(requestedUrl?.searchParams.get("idGte")).toBe("bundle-20");
    expect(requestedUrl?.searchParams.get("limit")).toBe("10");
    expect(requestedUrl?.searchParams.get("page")).toBe("3");
    expect(requestedUrl?.searchParams.get("orderDirection")).toBe("desc");
  });

  it("forwards bounded ascending bundle order to the aggregate endpoint", async () => {
    let requestedUrl: URL | undefined;
    server.use(
      http.get(`${BASE_URL}/bundles`, ({ request }) => {
        requestedUrl = new URL(request.url);
        return HttpResponse.json({
          data: [bundle("00000000-0000-0000-0000-000000000031")],
          pagination: {
            total: 2,
            hasNextPage: true,
            hasPreviousPage: false,
            currentPage: 1,
            totalPages: 2,
          },
        });
      }),
    );

    const result = await createRepository().models.bundles.findMany({
      orderBy: { field: "id", direction: "asc" },
      limit: 1,
      offset: 0,
    });

    expect(result.map(({ id }) => id)).toEqual([
      "00000000-0000-0000-0000-000000000031",
    ]);
    expect(requestedUrl?.searchParams.get("limit")).toBe("1");
    expect(requestedUrl?.searchParams.get("page")).toBe("1");
    expect(requestedUrl?.searchParams.get("orderDirection")).toBe("asc");
  });

  it("counts filtered artifact values through the compatibility view", async () => {
    const first = bundle("00000000-0000-0000-0000-000000000041");
    const second = bundle("00000000-0000-0000-0000-000000000042");
    const preview = bundle("00000000-0000-0000-0000-000000000043", {
      platform: "android",
    });
    bundles.set(first.id, first);
    bundles.set(second.id, second);
    bundles.set(preview.id, preview);
    let requestedUrl: URL | undefined;
    server.use(
      http.get(`${BASE_URL}/bundles`, ({ request }) => {
        requestedUrl = new URL(request.url);
        return HttpResponse.json({
          data: [first],
          pagination: {
            total: 2,
            hasNextPage: true,
            hasPreviousPage: false,
            currentPage: 1,
            totalPages: 2,
          },
        });
      }),
    );

    const result = await createRepository().models.bundles.count({
      platform: "ios",
    });

    expect(result).toBe(2);
    expect(requestedUrl?.searchParams.get("platform")).toBe("ios");
  });

  it("counts all bundle rows", async () => {
    const productionIos = bundle("00000000-0000-0000-0000-000000000044");
    const productionAndroid = bundle("00000000-0000-0000-0000-000000000045", {
      platform: "android",
    });
    const previewIos = bundle("00000000-0000-0000-0000-000000000046", {
      storageUri: "storage://preview",
    });
    bundles.set(productionIos.id, productionIos);
    bundles.set(productionAndroid.id, productionAndroid);
    bundles.set(previewIos.id, previewIos);

    const result = await createRepository().models.bundles.count();

    expect(result).toBe(3);
  });

  it("counts patch rows independently from bundle rows", async () => {
    const base = bundle("00000000-0000-0000-0000-000000000047");
    const target = bundle("00000000-0000-0000-0000-000000000048", {
      patches: [
        {
          baseBundleId: base.id,
          baseFileHash: base.fileHash,
          patchFileHash: "patch-hash",
          patchStorageUri: "storage://patch",
          byteSize: 3_000_000_002,
        },
      ],
    });
    bundles.set(base.id, base);
    bundles.set(target.id, target);

    const result =
      await createRepository().models.bundlePatches.findByBundleIds([
        target.id,
      ]);

    expect(result).toHaveLength(1);
  });

  it("returns the highest id for a filtered platform", async () => {
    const production = bundle("00000000-0000-0000-0000-000000000051");
    const previewLow = bundle("00000000-0000-0000-0000-000000000052", {
      platform: "android",
    });
    const previewHigh = bundle("00000000-0000-0000-0000-000000000053", {
      platform: "android",
    });
    bundles.set(production.id, production);
    bundles.set(previewLow.id, previewLow);
    bundles.set(previewHigh.id, previewHigh);
    let requestedUrl: URL | undefined;
    server.use(
      http.get(`${BASE_URL}/bundles`, ({ request }) => {
        requestedUrl = new URL(request.url);
        return HttpResponse.json({
          data: [previewHigh],
          pagination: {
            total: 2,
            hasNextPage: true,
            hasPreviousPage: false,
            currentPage: 1,
            totalPages: 2,
          },
        });
      }),
    );

    const result = await createRepository().models.bundles.findMany({
      where: { platform: "android" },
      orderBy: { field: "id", direction: "desc" },
      limit: 1,
      offset: 0,
    });

    expect(result.map(({ id }) => id)).toEqual([previewHigh.id]);
    expect(requestedUrl?.searchParams.get("platform")).toBe("android");
    expect(requestedUrl?.searchParams.get("orderDirection")).toBe("desc");
  });

  it("returns an empty bundle window without sending an invalid zero limit", async () => {
    const value = bundle("00000000-0000-0000-0000-000000000023");
    bundles.set(value.id, value);

    await expect(
      createRepository().models.bundles.findMany({
        limit: 0,
        offset: 0,
        orderBy: { field: "id", direction: "asc" },
      }),
    ).resolves.toEqual([]);
    expect(requestPaths).toEqual([]);
  });

  it("keeps an empty id set local", async () => {
    const value = bundle("00000000-0000-0000-0000-000000000024");
    bundles.set(value.id, value);
    let requestedUrl: URL | undefined;
    server.use(
      http.get(`${BASE_URL}/bundles`, ({ request }) => {
        requestedUrl = new URL(request.url);
        return HttpResponse.json({
          data: [...bundles.values()],
          pagination: {
            total: bundles.size,
            hasNextPage: false,
            hasPreviousPage: false,
            currentPage: 1,
            totalPages: 1,
          },
        });
      }),
    );

    await expect(
      createRepository().models.bundles.findMany({
        where: { id: { in: [] } },
        limit: 100,
        offset: 0,
        orderBy: { field: "id", direction: "asc" },
      }),
    ).resolves.toEqual([]);
    expect(requestedUrl?.searchParams.has("channel")).toBe(false);
  });

  it("forwards direct platform filters to the aggregate endpoint", async () => {
    const value = bundle("00000000-0000-0000-0000-000000000025");
    bundles.set(value.id, value);
    let requestedUrl: URL | undefined;
    server.use(
      http.get(`${BASE_URL}/bundles`, ({ request }) => {
        requestedUrl = new URL(request.url);
        const platform = requestedUrl.searchParams.get("platform");
        const filtered = [...bundles.values()].filter(
          (bundle) => platform === null || bundle.platform === platform,
        );
        return HttpResponse.json({
          data: filtered,
          pagination: {
            total: filtered.length,
            hasNextPage: false,
            hasPreviousPage: false,
            currentPage: 1,
            totalPages: 1,
          },
        });
      }),
    );

    await expect(
      createDatabaseClient(createRepository()).getBundles({
        limit: 50,
        where: { platform: "android" },
      }),
    ).resolves.toMatchObject({ data: [], pagination: { total: 0 } });
    expect(requestedUrl?.searchParams.get("platform")).toBe("android");
    expect(requestedUrl?.searchParams.has("idIn")).toBe(false);
  });

  it("queries patch rows from aggregate bundle responses", async () => {
    const base = bundle("00000000-0000-0000-0000-000000000011");
    const target = bundle("00000000-0000-0000-0000-000000000012", {
      patches: [
        {
          baseBundleId: base.id,
          baseFileHash: base.fileHash,
          patchFileHash: "patch-hash",
          patchStorageUri: "storage://patch",
          byteSize: 3_000_000_002,
        },
      ],
    });
    bundles.set(base.id, base);
    bundles.set(target.id, target);
    channels.add("production");

    const rows = await createRepository().models.bundlePatches.findByBundleIds([
      target.id,
    ]);

    expect(rows).toEqual([
      expect.objectContaining({
        bundle_id: target.id,
        base_bundle_id: base.id,
        patch_file_hash: "patch-hash",
      }),
    ]);
  });

  it("does not expose provider-owned update decisions", () => {
    expect(Reflect.has(createRepository(), "queries")).toBe(false);
  });

  it("preserves common headers on the canonical Channel route", async () => {
    let authorization: string | null = null;
    server.use(
      http.get("http://localhost/channels", ({ request }) => {
        authorization = request.headers.get("Authorization");
        return HttpResponse.json({
          data: {
            channels: [{ id: "channel-custom", name: "custom" }],
          },
        });
      }),
    );
    const repository = standaloneRepository({
      baseUrl: "http://localhost",
      commonHeaders: { Authorization: "Bearer token" },
    });

    await expect(repository.models.channels.list({})).resolves.toEqual({
      channels: [{ id: "channel-custom", name: "custom" }],
    });
    expect(authorization).toBe("Bearer token");
  });

  it("rejects malformed existing-route responses", async () => {
    server.use(
      http.get(`${BASE_URL}/bundles`, () =>
        HttpResponse.json({ data: "invalid" }),
      ),
    );

    await expect(
      createRepository().models.bundles.findMany({
        limit: 100,
        offset: 0,
        orderBy: { field: "id", direction: "asc" },
      }),
    ).rejects.toEqual(
      new StandaloneDatabaseError(
        "invalid-response",
        "Invalid bundle list response.",
        200,
      ),
    );
  });

  it("rejects incomplete pagination metadata", async () => {
    server.use(
      http.get(`${BASE_URL}/bundles`, () =>
        HttpResponse.json({ data: [], pagination: {} }),
      ),
    );

    await expect(
      createRepository().models.bundles.findMany({
        limit: 100,
        offset: 0,
        orderBy: { field: "id", direction: "asc" },
      }),
    ).rejects.toEqual(
      new StandaloneDatabaseError(
        "invalid-response",
        "Invalid bundle list response.",
        200,
      ),
    );
  });
});
