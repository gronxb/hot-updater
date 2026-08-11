import type { Bundle, DatabasePlugin } from "@hot-updater/plugin-core";
import { createDatabaseClient } from "@hot-updater/plugin-core";
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
  type StandaloneRepositoryConfig,
} from "./standaloneRepository";

const BASE_URL = "http://localhost/hot-updater";
const bundles = new Map<string, Bundle>();
const channels = new Set<string>();
const requestPaths: string[] = [];
const createRequestBodies: unknown[] = [];

const bundle = (id: string, overrides: Partial<Bundle> = {}): Bundle => ({
  id,
  platform: "ios",
  shouldForceUpdate: false,
  enabled: true,
  fileHash: `hash-${id}`,
  gitCommitHash: null,
  message: id,
  channel: "production",
  storageUri: `storage://${id}`,
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  ...overrides,
});

const server = setupServer(
  http.get(`${BASE_URL}/api/bundles/channels`, ({ request }) => {
    requestPaths.push(new URL(request.url).pathname);
    return HttpResponse.json({ data: { channels: [...channels] } });
  }),
  http.get(`${BASE_URL}/api/bundles/:id`, ({ params, request }) => {
    requestPaths.push(new URL(request.url).pathname);
    const value = bundles.get(String(params.id));
    return value
      ? HttpResponse.json(value)
      : HttpResponse.json({ error: "Not found" }, { status: 404 });
  }),
  http.get(`${BASE_URL}/api/bundles`, ({ request }) => {
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
  http.post(`${BASE_URL}/api/bundles`, async ({ request }) => {
    requestPaths.push(new URL(request.url).pathname);
    const body: unknown = await request.json();
    createRequestBodies.push(body);
    const values = Array.isArray(body) ? body : [body];
    for (const value of values) {
      if (typeof value === "object" && value !== null && "id" in value) {
        const next = value as Bundle;
        bundles.set(next.id, next);
        channels.add(next.channel);
      }
    }
    return HttpResponse.json({ success: true }, { status: 201 });
  }),
  http.patch(`${BASE_URL}/api/bundles/:id`, async ({ params, request }) => {
    requestPaths.push(new URL(request.url).pathname);
    const id = String(params.id);
    const current = bundles.get(id);
    if (!current) {
      return HttpResponse.json({ error: "Not found" }, { status: 404 });
    }
    const update = (await request.json()) as Partial<Bundle>;
    const next = { ...current, ...update, id };
    bundles.set(id, next);
    channels.add(next.channel);
    return HttpResponse.json({ success: true });
  }),
  http.delete(`${BASE_URL}/api/bundles/:id`, ({ params, request }) => {
    requestPaths.push(new URL(request.url).pathname);
    bundles.delete(String(params.id));
    return HttpResponse.json({ success: true });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  bundles.clear();
  channels.clear();
  requestPaths.length = 0;
  createRequestBodies.length = 0;
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const createRepository = (): DatabasePlugin =>
  standaloneRepository({ baseUrl: BASE_URL });

describe("standaloneRepository", () => {
  it("keeps the existing user config source-compatible", () => {
    type ExistingUserConfig = {
      baseUrl: string;
      commonHeaders?: Record<string, string>;
      routes?: {
        create?: () => { path: string };
        list?: () => { path: string };
        channels?: () => { path: string };
        retrieve?: (bundleId: string) => { path: string };
        update?: (bundleId: string) => { path: string };
        delete?: (bundleId: string) => { path: string };
      };
    };
    expectTypeOf<ExistingUserConfig>().toMatchTypeOf<StandaloneRepositoryConfig>();
  });

  it("uses only the existing bundle routes for aggregate mutations", async () => {
    const base = bundle("00000000-0000-0000-0000-000000000001");
    const target = bundle("00000000-0000-0000-0000-000000000002", {
      patches: [
        {
          baseBundleId: base.id,
          baseFileHash: base.fileHash,
          patchFileHash: "patch-hash",
          patchStorageUri: "storage://patch",
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
    expect(requestPaths).not.toContainEqual(
      expect.stringContaining("/database/"),
    );
    expect(
      requestPaths.every((path) => path.startsWith("/hot-updater/api/bundles")),
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
      await transaction.updateBundleById(target.id, { enabled: false });
      throw new Error("reject transaction");
    });

    await expect(mutation).rejects.toThrow("reject transaction");
    await expect(client.getBundleById(target.id)).resolves.toMatchObject({
      enabled: true,
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
      [
        expect.objectContaining({ id: ios.id, platform: "ios" }),
        expect.objectContaining({ id: android.id, platform: "android" }),
      ],
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
      http.post(`${BASE_URL}/api/bundles`, async ({ request }) => {
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
    expect(createRequestBodies[0]).toEqual([
      expect.objectContaining({ id: first.id }),
      expect.objectContaining({ id: second.id }),
    ]);
  });

  it("loads channels through the existing channels route", async () => {
    channels.add("preview");
    const repository = createRepository();

    await expect(repository.getChannels?.()).resolves.toEqual(["preview"]);
    expect(bundles.size).toBe(0);
    expect(requestPaths).toContain("/hot-updater/api/bundles/channels");
  });

  it("keeps aggregate bundle channel names", async () => {
    const value = bundle("00000000-0000-0000-0000-000000000021", {
      channel: "preview",
    });
    bundles.set(value.id, value);
    channels.add("preview");

    await expect(
      createRepository().bundles.findById(value.id),
    ).resolves.toMatchObject({
      id: value.id,
      channel: "preview",
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
    );
    const repository = standaloneRepository({
      baseUrl: "http://localhost",
      routes: {
        retrieve: (bundleId) => ({ path: `/custom/bundles/${bundleId}` }),
      },
    });

    await expect(repository.bundles.findById(value.id)).resolves.toMatchObject({
      id: value.id,
      channel: "production",
    });
    expect(retrieveCalls).toBe(1);
  });

  it("forwards supported bundle filters and page-aligned offsets", async () => {
    let requestedUrl: URL | undefined;
    server.use(
      http.get(`${BASE_URL}/api/bundles`, ({ request }) => {
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

    await createRepository().bundles.findMany({
      where: {
        channel: "preview",
        platform: "ios",
        enabled: true,
        id: { gte: "bundle-20" },
      },
      orderBy: { field: "id", direction: "desc" },
      limit: 10,
      offset: 20,
    });

    expect(requestedUrl?.searchParams.get("channel")).toBe("preview");
    expect(requestedUrl?.searchParams.get("platform")).toBe("ios");
    expect(requestedUrl?.searchParams.get("enabled")).toBe("true");
    expect(requestedUrl?.searchParams.get("idGte")).toBe("bundle-20");
    expect(requestedUrl?.searchParams.get("limit")).toBe("10");
    expect(requestedUrl?.searchParams.get("page")).toBe("3");
    expect(requestedUrl?.searchParams.get("orderDirection")).toBe("desc");
  });

  it("forwards bounded ascending bundle order to the aggregate endpoint", async () => {
    let requestedUrl: URL | undefined;
    server.use(
      http.get(`${BASE_URL}/api/bundles`, ({ request }) => {
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

    const result = await createRepository().bundles.findMany({
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

  it("counts filtered bundle values through the compatibility view", async () => {
    const first = bundle("00000000-0000-0000-0000-000000000041");
    const second = bundle("00000000-0000-0000-0000-000000000042");
    const preview = bundle("00000000-0000-0000-0000-000000000043", {
      channel: "preview",
    });
    bundles.set(first.id, first);
    bundles.set(second.id, second);
    bundles.set(preview.id, preview);
    let requestedUrl: URL | undefined;
    server.use(
      http.get(`${BASE_URL}/api/bundles`, ({ request }) => {
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

    const result = await createRepository().bundles.count({
      channel: "production",
    });

    expect(result).toBe(2);
    expect(requestedUrl?.searchParams.get("channel")).toBe("production");
  });

  it("counts all bundle rows", async () => {
    const productionIos = bundle("00000000-0000-0000-0000-000000000044");
    const productionAndroid = bundle("00000000-0000-0000-0000-000000000045", {
      platform: "android",
    });
    const previewIos = bundle("00000000-0000-0000-0000-000000000046", {
      channel: "preview",
    });
    bundles.set(productionIos.id, productionIos);
    bundles.set(productionAndroid.id, productionAndroid);
    bundles.set(previewIos.id, previewIos);

    const result = await createRepository().bundles.count();

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
        },
      ],
    });
    bundles.set(base.id, base);
    bundles.set(target.id, target);

    const result = await createRepository().bundlePatches.findByBundleIds([
      target.id,
    ]);

    expect(result).toHaveLength(1);
  });

  it("returns the highest id for a filtered channel", async () => {
    const production = bundle("00000000-0000-0000-0000-000000000051");
    const previewLow = bundle("00000000-0000-0000-0000-000000000052", {
      channel: "preview",
    });
    const previewHigh = bundle("00000000-0000-0000-0000-000000000053", {
      channel: "preview",
    });
    bundles.set(production.id, production);
    bundles.set(previewLow.id, previewLow);
    bundles.set(previewHigh.id, previewHigh);
    let requestedUrl: URL | undefined;
    server.use(
      http.get(`${BASE_URL}/api/bundles`, ({ request }) => {
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

    const result = await createRepository().bundles.findMany({
      where: { channel: "preview" },
      orderBy: { field: "id", direction: "desc" },
      limit: 1,
      offset: 0,
    });

    expect(result.map(({ id }) => id)).toEqual([previewHigh.id]);
    expect(requestedUrl?.searchParams.get("channel")).toBe("preview");
    expect(requestedUrl?.searchParams.get("orderDirection")).toBe("desc");
  });

  it("returns an empty bundle window without sending an invalid zero limit", async () => {
    const value = bundle("00000000-0000-0000-0000-000000000023");
    bundles.set(value.id, value);

    await expect(
      createRepository().bundles.findMany({
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
      http.get(`${BASE_URL}/api/bundles`, ({ request }) => {
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
      createRepository().bundles.findMany({
        where: { id: { in: [] } },
        limit: 100,
        offset: 0,
        orderBy: { field: "id", direction: "asc" },
      }),
    ).resolves.toEqual([]);
    expect(requestedUrl?.searchParams.has("channel")).toBe(false);
  });

  it("forwards direct channel filters to the aggregate endpoint", async () => {
    const value = bundle("00000000-0000-0000-0000-000000000025");
    bundles.set(value.id, value);
    let requestedUrl: URL | undefined;
    server.use(
      http.get(`${BASE_URL}/api/bundles`, ({ request }) => {
        requestedUrl = new URL(request.url);
        const channel = requestedUrl.searchParams.get("channel");
        const filtered = [...bundles.values()].filter(
          (bundle) => channel === null || bundle.channel === channel,
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
        where: { channel: "missing" },
      }),
    ).resolves.toMatchObject({ data: [], pagination: { total: 0 } });
    expect(requestedUrl?.searchParams.get("channel")).toBe("missing");
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
        },
      ],
    });
    bundles.set(base.id, base);
    bundles.set(target.id, target);
    channels.add("production");

    const rows = await createRepository().bundlePatches.findByBundleIds([
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

  it("does not expose a standalone update-info capability flag", () => {
    expect(createRepository().getUpdateInfo).toBeUndefined();
  });

  it("preserves custom routes and common headers", async () => {
    let authorization: string | null = null;
    server.use(
      http.get("http://localhost/custom/channels", ({ request }) => {
        authorization = request.headers.get("Authorization");
        return HttpResponse.json({ data: { channels: ["custom"] } });
      }),
    );
    const repository = standaloneRepository({
      baseUrl: "http://localhost",
      commonHeaders: { Authorization: "Bearer token" },
      routes: { channels: () => ({ path: "/custom/channels" }) },
    });

    await expect(repository.getChannels?.()).resolves.toEqual(["custom"]);
    expect(authorization).toBe("Bearer token");
  });

  it("rejects malformed existing-route responses", async () => {
    server.use(
      http.get(`${BASE_URL}/api/bundles`, () =>
        HttpResponse.json({ data: "invalid" }),
      ),
    );

    await expect(
      createRepository().bundles.findMany({
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
      http.get(`${BASE_URL}/api/bundles`, () =>
        HttpResponse.json({ data: [], pagination: {} }),
      ),
    );

    await expect(
      createRepository().bundles.findMany({
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
