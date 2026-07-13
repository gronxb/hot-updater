import type { Bundle, DatabaseAdapter } from "@hot-updater/plugin-core";
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
  it,
} from "vitest";

import {
  StandaloneDatabaseError,
  standaloneRepository,
} from "./standaloneRepository";

const BASE_URL = "http://localhost/hot-updater";
const bundles = new Map<string, Bundle>();
const channels = new Set<string>();
const requestPaths: string[] = [];

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
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const createRepository = (): DatabaseAdapter =>
  standaloneRepository({ baseUrl: BASE_URL });

describe("standaloneRepository", () => {
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

  it("aliases a supplied channel id to its legacy name deterministically", async () => {
    const repository = createRepository();

    const created = await repository.create({
      model: "channels",
      data: { id: "generated-preview-id", name: "preview" },
    });

    expect(created).toEqual({ id: "preview", name: "preview" });
    await expect(repository.findMany({ model: "channels" })).resolves.toEqual([
      created,
    ]);
    expect(bundles.size).toBe(0);
    expect(requestPaths).not.toContainEqual(
      expect.stringContaining("/database/"),
    );
  });

  it("rejects a duplicate channel name through the existing channels route", async () => {
    channels.add("preview");
    const repository = createRepository();

    await expect(
      repository.create({
        model: "channels",
        data: { id: "another-id", name: "preview" },
      }),
    ).rejects.toEqual(
      new StandaloneDatabaseError(
        "request-failed",
        "Channel preview already exists.",
        409,
      ),
    );
  });

  it("normalizes aggregate bundle channels to low channel ids", async () => {
    const value = bundle("00000000-0000-0000-0000-000000000021", {
      channel: "preview",
    });
    bundles.set(value.id, value);
    channels.add("preview");

    await expect(
      createRepository().findOne({
        model: "bundles",
        where: [{ field: "id", value: value.id }],
      }),
    ).resolves.toMatchObject({
      id: value.id,
      channel_id: "preview",
    });
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

    const rows = await createRepository().findMany({
      model: "bundle_patches",
      where: [{ field: "bundle_id", value: target.id }],
      sortBy: { field: "order_index", direction: "asc" },
    });

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

    await expect(repository.findMany({ model: "channels" })).resolves.toEqual([
      { id: "custom", name: "custom" },
    ]);
    expect(authorization).toBe("Bearer token");
  });

  it("rejects malformed existing-route responses", async () => {
    server.use(
      http.get(`${BASE_URL}/api/bundles`, () =>
        HttpResponse.json({ data: "invalid" }),
      ),
    );

    await expect(
      createRepository().findMany({ model: "bundles" }),
    ).rejects.toEqual(
      new StandaloneDatabaseError(
        "invalid-response",
        "Invalid bundle list response.",
        200,
      ),
    );
  });
});
