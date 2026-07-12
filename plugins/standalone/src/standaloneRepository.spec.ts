import type {
  BundlePatchRow,
  BundleRow,
  ChannelRow,
  DatabasePlugin,
} from "@hot-updater/plugin-core";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  StandaloneDatabaseError,
  standaloneRepository,
} from "./standaloneRepository";

const BASE_URL = "http://localhost/hot-updater";
const DATABASE_URL = `${BASE_URL}/api/database/v2`;

const channel: ChannelRow = { id: "production" };
const bundle: BundleRow = {
  id: "00000000-0000-0000-0000-000000000001",
  platform: "ios",
  should_force_update: false,
  enabled: true,
  file_hash: "bundle-hash",
  git_commit_hash: null,
  message: null,
  channel: channel.id,
  storage_uri: "s3://bucket/bundle.zip",
  target_app_version: "1.x",
  fingerprint_hash: null,
  metadata: null,
  rollout_cohort_count: 100,
  target_cohorts: null,
  manifest_storage_uri: null,
  manifest_file_hash: null,
  asset_base_storage_uri: null,
};
const patch: BundlePatchRow = {
  id: "patch-1",
  bundle_id: bundle.id,
  base_bundle_id: "00000000-0000-0000-0000-000000000000",
  base_file_hash: "base-hash",
  patch_file_hash: "patch-hash",
  patch_storage_uri: "s3://bucket/patch.bin",
  order_index: 0,
};

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const createRepository = (): DatabasePlugin =>
  standaloneRepository({ baseUrl: BASE_URL });

describe("standaloneRepository v2 protocol", () => {
  it("sends a versioned allowlisted create request and returns projection", async () => {
    let body: unknown;
    server.use(
      http.post(`${DATABASE_URL}/channels/create`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ data: channel });
      }),
    );

    const created = await createRepository().create({
      model: "channels",
      data: channel,
      select: ["id"],
    });

    expect(body).toEqual({ data: channel, select: ["id"] });
    expect(created).toEqual(channel);
  });

  it("forwards a bundle update without aggregate append or commit calls", async () => {
    let body: unknown;
    server.use(
      http.post(`${DATABASE_URL}/bundles/update`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ data: { id: bundle.id, enabled: false } });
      }),
    );

    const updated = await createRepository().update({
      model: "bundles",
      where: [{ field: "id", value: bundle.id }],
      update: { enabled: false },
      select: ["id", "enabled"],
    });

    expect(body).toEqual({
      where: [{ field: "id", value: bundle.id }],
      update: { enabled: false },
      select: ["id", "enabled"],
    });
    expect(updated).toEqual({ id: bundle.id, enabled: false });
  });

  it("forwards findMany query semantics and validates every returned row", async () => {
    let body: unknown;
    server.use(
      http.post(
        `${DATABASE_URL}/bundle_patches/findMany`,
        async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({ data: [patch] });
        },
      ),
    );

    const rows = await createRepository().findMany({
      model: "bundle_patches",
      where: [{ field: "bundle_id", value: bundle.id }],
      sortBy: { field: "order_index", direction: "asc" },
      limit: 25,
      offset: 5,
    });

    expect(body).toEqual({
      where: [{ field: "bundle_id", value: bundle.id }],
      sortBy: { field: "order_index", direction: "asc" },
      limit: 25,
      offset: 5,
    });
    expect(rows).toEqual([patch]);
  });

  it("supports the remaining allowlisted operation pairs", async () => {
    const requests: string[] = [];
    server.use(
      http.post(`${DATABASE_URL}/bundles/count`, ({ request }) => {
        requests.push(new URL(request.url).pathname);
        return HttpResponse.json({ data: 1 });
      }),
      http.post(`${DATABASE_URL}/channels/findOne`, ({ request }) => {
        requests.push(new URL(request.url).pathname);
        return HttpResponse.json({ data: channel });
      }),
      http.post(`${DATABASE_URL}/bundle_patches/delete`, ({ request }) => {
        requests.push(new URL(request.url).pathname);
        return HttpResponse.json({ data: null });
      }),
    );
    const repository = createRepository();

    await expect(repository.count({ model: "bundles" })).resolves.toBe(1);
    await expect(
      repository.findOne({
        model: "channels",
        where: [{ field: "id", value: channel.id }],
      }),
    ).resolves.toEqual(channel);
    await expect(
      repository.delete({
        model: "bundle_patches",
        where: [{ field: "id", value: patch.id }],
      }),
    ).resolves.toBeUndefined();
    expect(requests).toEqual([
      "/hot-updater/api/database/v2/bundles/count",
      "/hot-updater/api/database/v2/channels/findOne",
      "/hot-updater/api/database/v2/bundle_patches/delete",
    ]);
  });

  it("rejects malformed projected response rows", async () => {
    server.use(
      http.post(`${DATABASE_URL}/bundles/findOne`, () =>
        HttpResponse.json({ data: { id: 123 } }),
      ),
    );

    await expect(
      createRepository().findOne({
        model: "bundles",
        select: ["id"],
      }),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("surfaces stable protocol errors from the server", async () => {
    server.use(
      http.post(`${DATABASE_URL}/bundles/findMany`, () =>
        HttpResponse.json(
          {
            error: {
              code: "invalid-request",
              message: "Unknown where operator.",
            },
          },
          { status: 400 },
        ),
      ),
    );

    await expect(
      createRepository().findMany({ model: "bundles" }),
    ).rejects.toEqual(
      new StandaloneDatabaseError(
        "invalid-request",
        "Unknown where operator.",
        400,
      ),
    );
  });

  it("uses the custom protocol root and common headers", async () => {
    let authorization: string | null = null;
    server.use(
      http.post(
        "http://localhost/custom/db/channels/findMany",
        ({ request }) => {
          authorization = request.headers.get("Authorization");
          return HttpResponse.json({ data: [channel] });
        },
      ),
    );
    const repository = standaloneRepository({
      baseUrl: "http://localhost",
      commonHeaders: { Authorization: "Bearer token" },
      routes: { database: () => ({ path: "/custom/db" }) },
    });

    await expect(repository.findMany({ model: "channels" })).resolves.toEqual([
      channel,
    ]);
    expect(authorization).toBe("Bearer token");
  });
});
