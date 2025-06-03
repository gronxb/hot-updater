import type { BasePluginArgs, Bundle } from "@hot-updater/plugin-core";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  type StandaloneRepositoryConfig,
  standaloneRepository,
} from "./standaloneRepository";

const DEFAULT_BUNDLE = {
  key: "bundle.zip",
  fileHash: "hash",
  platform: "ios",
  gitCommitHash: null,
  message: null,
} as const;

const testBundles: Bundle[] = [
  {
    ...DEFAULT_BUNDLE,
    targetAppVersion: "*",
    shouldForceUpdate: false,
    enabled: true,
    id: "00000000-0000-0000-0000-000000000001",
    channel: "production",
    storageUri: "gs://test-bucket/test-key",
    fingerprintHash: null,
  },
];

const TEST_BUNDLE_1 = {
  id: "bundle1",
  channel: "production",
  enabled: true,
  shouldForceUpdate: true,
  fileHash: "hash1",
  gitCommitHash: "commit1",
  message: "bundle 1",
  platform: "android",
  targetAppVersion: "2.0.0",
  storageUri: "gs://test-bucket/test-key",
  fingerprintHash: null,
} as const;

const TEST_BUNDLE_2 = {
  id: "bundle2",
  channel: "production",
  enabled: false,
  shouldForceUpdate: false,
  fileHash: "hash2",
  gitCommitHash: "commit2",
  message: "bundle 2",
  platform: "ios",
  targetAppVersion: "1.0.0",
  storageUri: "gs://test-bucket/test-key",
  fingerprintHash: null,
} as const;

const TEST_BUNDLE_3 = {
  id: "bundle3",
  channel: "staging",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "hash3",
  gitCommitHash: "commit3",
  message: "bundle 3",
  platform: "android",
  targetAppVersion: "1.5.0",
  storageUri: "gs://test-bucket/test-key",
  fingerprintHash: null,
} as const;

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("Standalone Repository Plugin (Default Routes)", () => {
  let repo: ReturnType<ReturnType<typeof standaloneRepository>>;
  let onDatabaseUpdated: () => Promise<void>;
  const config: StandaloneRepositoryConfig = {
    baseUrl: "http://localhost",
  };

  beforeEach(() => {
    onDatabaseUpdated = vi.fn();
    repo = standaloneRepository(config, { onDatabaseUpdated })(
      {} as BasePluginArgs,
    );
  });

  it("getBundles: GET /bundles fetches bundle list", async () => {
    let callCount = 0;
    server.use(
      http.get("http://localhost/bundles", ({ request }) => {
        callCount++;
        expect(request.headers.get("Content-Type")).toEqual("application/json");
        expect(request.headers.get("Cache-Control")).toEqual("no-cache");
        return HttpResponse.json(testBundles);
      }),
    );

    const bundles = await repo.getBundles({ limit: 20, offset: 0 });
    expect(bundles.data).toEqual(testBundles);
    expect(callCount).toBe(1);
  });

  it("getBundles: makes new request when refresh is true", async () => {
    let callCount = 0;
    server.use(
      http.get("http://localhost/bundles", () => {
        callCount++;
        return HttpResponse.json(testBundles);
      }),
    );

    await repo.getBundles({ limit: 20, offset: 0 });
    const refreshed = await repo.getBundles({ limit: 20, offset: 0 });
    expect(refreshed.data).toEqual(testBundles);
    expect(callCount).toBe(2);
  });

  it("should return correct pagination info for single page", async () => {
    // Mock initial bundles fetch
    server.use(
      http.get("http://localhost/bundles", () => {
        return HttpResponse.json([]);
      }),
      http.post("http://localhost/bundles", async ({ request }) => {
        const body = await request.json();
        return HttpResponse.json({ success: true });
      }),
    );

    await repo.appendBundle(TEST_BUNDLE_1);
    await repo.appendBundle(TEST_BUNDLE_2);
    await repo.appendBundle(TEST_BUNDLE_3);
    await repo.commitBundle();

    // Mock filtered bundles response
    const productionBundles = [TEST_BUNDLE_2, TEST_BUNDLE_1];
    server.use(
      http.get("http://localhost/bundles", ({ request }) => {
        const url = new URL(request.url);
        const channel = url.searchParams.get("channel");
        if (channel === "production") {
          return HttpResponse.json(productionBundles);
        }
        return HttpResponse.json([TEST_BUNDLE_1, TEST_BUNDLE_2, TEST_BUNDLE_3]);
      }),
    );

    const result = await repo.getBundles({
      where: { channel: "production" },
      limit: 20,
      offset: 0,
    });

    expect(result.data).toHaveLength(2);
    expect(result.data[0].id).toBe("bundle1");
    expect(result.data[1].id).toBe("bundle2");

    expect(result.pagination).toEqual({
      total: 2,
      hasNextPage: false,
      hasPreviousPage: false,
      currentPage: 1,
      totalPages: 1,
    });
  });

  it("should return correct pagination info for multiple pages", async () => {
    // Mock paginated responses
    const allBundles = [TEST_BUNDLE_1, TEST_BUNDLE_2, TEST_BUNDLE_3];
    server.use(
      http.get("http://localhost/bundles", ({ request }) => {
        const url = new URL(request.url);
        const limit = Number.parseInt(url.searchParams.get("limit") || "20");
        const offset = Number.parseInt(url.searchParams.get("offset") || "0");

        const paginatedData = allBundles.slice(offset, offset + limit);
        return HttpResponse.json(paginatedData, {
          headers: {
            "X-Total-Count": allBundles.length.toString(),
          },
        });
      }),
      http.post("http://localhost/bundles", async () => {
        return HttpResponse.json({ success: true });
      }),
    );

    await repo.appendBundle(TEST_BUNDLE_1);
    await repo.appendBundle(TEST_BUNDLE_2);
    await repo.appendBundle(TEST_BUNDLE_3);
    await repo.commitBundle();

    const firstPage = await repo.getBundles({
      limit: 2,
      offset: 0,
    });

    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.pagination).toEqual({
      total: 3,
      hasNextPage: true,
      hasPreviousPage: false,
      currentPage: 1,
      totalPages: 2,
    });

    const secondPage = await repo.getBundles({
      limit: 2,
      offset: 2,
    });

    expect(secondPage.data).toHaveLength(1);
    expect(secondPage.pagination).toEqual({
      total: 3,
      hasNextPage: false,
      hasPreviousPage: true,
      currentPage: 2,
      totalPages: 2,
    });
  });

  it("getBundleById: GET /bundles/:id retrieves a bundle (success case)", async () => {
    server.use(
      http.get("http://localhost/bundles/:bundleId", ({ params, request }) => {
        const { bundleId } = params;
        if (bundleId === testBundles[0].id) {
          expect(request.headers.get("Accept")).toEqual("application/json");
          return HttpResponse.json(testBundles[0]);
        }
        return HttpResponse.error();
      }),
    );

    const bundle = await repo.getBundleById(
      "00000000-0000-0000-0000-000000000001",
    );
    expect(bundle).toEqual(testBundles[0]);
  });

  it("getBundleById: returns null when retrieval fails", async () => {
    server.use(
      http.get("http://localhost/bundles/:bundleId", () => {
        return HttpResponse.error();
      }),
    );

    const bundle = await repo.getBundleById("non-existent");
    expect(bundle).toBeNull();
  });

  it("getBundleById: returns null on network error", async () => {
    server.use(
      http.get("http://localhost/bundles/:bundleId", () => {
        throw new Error("Network failure");
      }),
    );

    const bundle = await repo.getBundleById(
      "00000000-0000-0000-0000-000000000001",
    );
    expect(bundle).toBeNull();
  });

  it("getBundles: throws error when API returns error", async () => {
    server.use(
      http.get("http://localhost/bundles", () => {
        return new HttpResponse(null, {
          status: 500,
          statusText: "Internal Server Error",
        });
      }),
    );

    await expect(repo.getBundles({ limit: 20, offset: 0 })).rejects.toThrow(
      "API Error: Internal Server Error",
    );
  });

  it("updateBundle & commitBundle: updates an existing bundle and commits", async () => {
    let postCalled = false;

    server.use(
      http.get("http://localhost/bundles", () => {
        return HttpResponse.json(testBundles);
      }),
      http.get("http://localhost/bundles/:bundleId", ({ params, request }) => {
        const { bundleId } = params;
        if (bundleId === testBundles[0].id) {
          expect(request.headers.get("Accept")).toEqual("application/json");
          return HttpResponse.json(testBundles[0]);
        }
        return HttpResponse.error();
      }),
      http.post("http://localhost/bundles", async ({ request }) => {
        postCalled = true;
        const body = (await request.json()) as Bundle[];
        expect(Array.isArray(body)).toBe(true);
        expect(body[0].id).toBe("00000000-0000-0000-0000-000000000001");
        expect(body[0].enabled).toBe(false);
        return HttpResponse.json({ success: true });
      }),
    );

    await repo.updateBundle("00000000-0000-0000-0000-000000000001", {
      enabled: false,
    });
    await repo.commitBundle();
    expect(postCalled).toBe(true);
    expect(onDatabaseUpdated).toHaveBeenCalled();
  });

  it("updateBundle: throws error if target bundle does not exist", async () => {
    server.use(
      http.get("http://localhost/bundles", () => {
        return HttpResponse.json([]);
      }),
    );

    await expect(
      repo.updateBundle("non-existent-id", { enabled: false }),
    ).rejects.toThrow("targetBundleId not found");
  });

  it("appendBundle & commitBundle: appends a new bundle and commits", async () => {
    server.use(
      http.get("http://localhost/bundles", () => {
        return HttpResponse.json([]);
      }),
    );

    const newBundle: Bundle = {
      ...DEFAULT_BUNDLE,
      targetAppVersion: "1.0.0",
      shouldForceUpdate: false,
      enabled: true,
      id: "00000000-0000-0000-0000-000000000002",
      channel: "production",
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
    };

    await repo.appendBundle(newBundle);

    let postCalled = false;
    server.use(
      http.post("http://localhost/bundles", async ({ request }) => {
        postCalled = true;
        const body = await request.json();
        expect(body).toEqual([newBundle]);
        return HttpResponse.json({ success: true });
      }),
    );

    await repo.commitBundle();
    expect(postCalled).toBe(true);
  });

  it("commitBundle: does nothing if there are no changes", async () => {
    const spy = vi.spyOn(global, "fetch");
    await repo.commitBundle();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("commitBundle: throws exception on API error", async () => {
    server.use(
      http.get("http://localhost/bundles", () => {
        return HttpResponse.json(testBundles);
      }),
      http.get("http://localhost/bundles/:bundleId", () => {
        return HttpResponse.json(testBundles[0]);
      }),
      http.post("http://localhost/bundles", () => {
        return new HttpResponse(null, {
          status: 500,
          statusText: "Internal Server Error",
        });
      }),
    );

    await repo.updateBundle("00000000-0000-0000-0000-000000000001", {
      enabled: false,
    });

    await expect(repo.commitBundle()).rejects.toStrictEqual(
      new Error("API Error: Internal Server Error"),
    );
  });
});

// ─── Custom Routes Tests ────────────────────────────────
describe("Standalone Repository Plugin (Custom Routes)", () => {
  let customRepo: ReturnType<ReturnType<typeof standaloneRepository>>;
  const customConfig: StandaloneRepositoryConfig = {
    baseUrl: "http://localhost/api",
    commonHeaders: { Authorization: "Bearer token" },
    routes: {
      upsert: () => ({
        path: "/custom/bundles",
        headers: { "X-Custom": "upsert" },
      }),
      list: () => ({
        path: "/custom/bundles",
        headers: { "Cache-Control": "max-age=60" },
      }),
      retrieve: (bundleId: string) => ({
        path: `/custom/bundles/${bundleId}`,
        headers: { Accept: "application/custom+json" },
      }),
    },
  };

  beforeEach(() => {
    customRepo = standaloneRepository(customConfig)({} as BasePluginArgs);
  });

  it("getBundles: uses custom list route and headers", async () => {
    server.use(
      http.get("http://localhost/api/custom/bundles", ({ request }) => {
        expect(request.headers.get("Authorization")).toEqual("Bearer token");
        expect(request.headers.get("Cache-Control")).toEqual("max-age=60");
        return HttpResponse.json(testBundles);
      }),
    );

    const bundles = await customRepo.getBundles({ limit: 20, offset: 0 });
    expect(bundles.data).toEqual(testBundles);
  });

  it("getBundleById: uses custom retrieve route and headers", async () => {
    server.use(
      http.get(
        "http://localhost/api/custom/bundles/:bundleId",
        ({ params, request }) => {
          expect(request.headers.get("Authorization")).toEqual("Bearer token");
          expect(request.headers.get("Accept")).toEqual(
            "application/custom+json",
          );
          const { bundleId } = params;
          if (bundleId === testBundles[0].id) {
            return HttpResponse.json(testBundles[0]);
          }
          return HttpResponse.error();
        },
      ),
    );

    const bundle = await customRepo.getBundleById(
      "00000000-0000-0000-0000-000000000001",
    );
    expect(bundle).toEqual(testBundles[0]);
  });
});
