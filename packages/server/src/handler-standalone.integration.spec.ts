import { PGlite } from "@electric-sql/pglite";
import type { Bundle } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { uuidv7 } from "uuidv7";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { standaloneRepository } from "../../../plugins/standalone/src";
import { kyselyAdapter } from "./adapters/kysely";
import { createMigrator } from "./db";
import { createHotUpdater, type RuntimeHotUpdaterAPI } from "./index";
import { insights } from "./plugins/insights";

const db = new PGlite();
const kysely = new Kysely<object>({ dialect: new PGliteDialect(db) });
const clientMountPath = "/hot-updater";
const api = createHotUpdater({
  database: kyselyAdapter({ db: kysely, provider: "postgresql" }),
  plugins: [insights()],
  clientAccess: "public",
});
const baseUrl = "http://localhost:3000";
const server = setupServer();
const invokeHandler = async (
  hotUpdater: RuntimeHotUpdaterAPI,
  request: Request,
  clientPath: string,
) => {
  const url = new URL(request.url);
  const adminBasePath = `${clientPath}/admin`;
  const isAdmin = url.pathname.startsWith(`${adminBasePath}/`);
  const mountPath = isAdmin ? adminBasePath : clientPath;
  url.pathname = url.pathname.slice(mountPath.length) || "/";
  const handler = isAdmin
    ? hotUpdater.handlers.admin
    : hotUpdater.handlers.client;
  const response = await handler(new Request(url, request));
  // A 204 carries no body, and a Response refuses one.
  return new HttpResponse(
    response.status === 204 ? null : await response.text(),
    { status: response.status, headers: response.headers },
  );
};

beforeAll(async () => {
  const result = await createMigrator(api).migrateToLatest({
    mode: "from-schema",
    updateSettings: true,
  });
  await result.execute();
  server.listen({ onUnhandledRequest: "error" });
  server.use(
    http.all(`${baseUrl}/hot-updater/*`, ({ request }) =>
      invokeHandler(api, request, clientMountPath),
    ),
  );
});

afterEach(async () => {
  // Every table but the settings rows, aggregates included.
  const { rows } = await db.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'private_hot_updater_settings'",
  );
  await db.exec(
    `TRUNCATE ${rows.map(({ tablename }) => `"${tablename}"`).join(", ")} CASCADE`,
  );
});

afterAll(async () => {
  server.close();
  await kysely.destroy();
  await db.close();
});

const createTestBundle = (overrides?: Partial<Bundle>): Bundle => ({
  id: NIL_UUID,
  platform: "ios",
  gitCommitHash: null,
  manifestStorageUri: "test://storage/manifest.json",
  manifestFileHash: "test-manifest-hash",
  assetBaseStorageUri: "test://assets",
  ...overrides,
});

describe("Standalone core API over admin API protocol 2", () => {
  const core = () =>
    standaloneRepository({ baseUrl: `${baseUrl}/hot-updater/admin` }).core;
  const deployment = (bundle: Bundle, channel = "production") => ({
    bundle,
    release: {
      channel,
      enabled: true,
      fingerprintHash: null,
      message: null,
      shouldForceUpdate: false,
      targetAppVersion: "1.0.0",
    },
  });

  it("deploys, lists by key, and reads bundles, releases, catalogs, and channels", async () => {
    const remote = core();
    const bundles = [uuidv7(), uuidv7(), uuidv7()].map((id) =>
      createTestBundle({ id }),
    );
    const deployed = [];
    for (const bundle of bundles) {
      deployed.push(...(await remote.deploy([deployment(bundle)])));
    }
    const scopeKey = deployed[0]!.catalog.scope_key;
    const channel = await remote.findChannelByName("production");

    expect(deployed.map(({ catalog }) => catalog.generation)).toEqual([
      1, 2, 3,
    ]);
    expect(channel).toMatchObject({ name: "production" });
    await expect(remote.listChannels()).resolves.toEqual([channel]);
    const first = await remote.listBundles({ limit: 2, order: "desc" });
    const second = await remote.listBundles({
      limit: 2,
      order: "desc",
      after: first.at(-1)!.bundle.id,
    });
    expect([...first, ...second].map(({ bundle }) => bundle.id)).toEqual(
      bundles.map(({ id }) => id).reverse(),
    );
    await expect(remote.countBundles()).resolves.toBe(3);
    await expect(remote.countBundles("android")).resolves.toBe(0);
    await expect(remote.getBundle(bundles[0]!.id)).resolves.toMatchObject({
      bundle: { id: bundles[0]!.id },
      patches: [],
      childCount: 0,
    });
    await expect(remote.getBundle(uuidv7())).resolves.toBeNull();
    await expect(
      remote.listReleases({
        limit: 10,
        order: "asc",
        filter: { kind: "scope", scopeKey, enabled: true },
      }),
    ).resolves.toHaveLength(3);
    await expect(
      remote.listReleases({
        limit: 10,
        filter: {
          kind: "channelPlatform",
          channelId: channel!.id,
          platform: "ios",
          enabled: false,
        },
      }),
    ).resolves.toEqual([]);
    await expect(remote.getReleaseCatalogRow(scopeKey)).resolves.toMatchObject({
      generation: 3,
    });
    await expect(remote.listReleaseCatalogs({ limit: 10 })).resolves.toEqual([
      expect.objectContaining({ scope_key: scopeKey }),
    ]);
  });

  it("changes, previews, promotes, and deletes releases, and rebuilds catalogs", async () => {
    const remote = core();
    const [deployed] = await remote.deploy([
      deployment(createTestBundle({ id: uuidv7() })),
    ]);
    const releaseId = deployed!.release!.id;
    const scopeKey = deployed!.catalog.scope_key;

    await expect(
      remote.preflightReleasePolicy({
        releaseId,
        patch: { rolloutCohortCount: 100 },
      }),
    ).resolves.toMatchObject({
      expectedReleaseRevision: 1,
      release: { revision: 2 },
    });
    await expect(
      remote.updateReleasePolicy({
        releaseId,
        expectedRevision: 1,
        patch: { rolloutCohortCount: 100 },
      }),
    ).resolves.toMatchObject({ release: { revision: 2 } });
    await expect(
      remote.updateReleasePolicy({
        releaseId,
        expectedRevision: 1,
        patch: { enabled: false },
      }),
    ).rejects.toMatchObject({
      name: "ReleaseManagementError",
      code: "VERSION_CONFLICT",
    });
    const promoted = await remote.promoteRelease({
      releaseId,
      targetChannel: "beta",
      action: "move",
    });
    expect(promoted.source!.release).toMatchObject({ enabled: false });
    expect(promoted.target.release).toMatchObject({
      operation: "PROMOTE",
      source_release_id: releaseId,
    });
    await expect(
      remote.preflightReleaseCatalogRebuild(scopeKey),
    ).resolves.toMatchObject({ changed: false });
    await expect(remote.rebuildReleaseCatalog(scopeKey)).resolves.toMatchObject(
      { changed: false },
    );
    await expect(remote.deleteRelease({ releaseId })).resolves.toMatchObject({
      release: null,
    });
    await expect(remote.getRelease(releaseId)).resolves.toBeNull();
  });

  it("creates and deletes channels, replaces patches, and refuses to delete a bundle a release uses", async () => {
    const remote = core();
    const base = createTestBundle({ id: uuidv7() });
    const target = createTestBundle({ id: uuidv7() });
    await remote.deploy([deployment(base)]);
    await remote.deploy([deployment(target)]);
    const qa = await remote.ensureChannel("qa");

    await expect(remote.ensureChannel("qa")).resolves.toEqual(qa);
    await expect(remote.deleteChannel(qa.id)).resolves.toEqual({
      deleted: true,
    });
    const production = await remote.findChannelByName("production");
    await expect(remote.deleteChannel(production!.id)).resolves.toEqual({
      deleted: false,
      reason: "not_empty",
    });
    await remote.updateBundle(target.id, {
      patches: [
        {
          baseBundleId: base.id,
          baseFileHash: "base-hash",
          byteSize: 10,
          patchFileHash: "patch-hash",
          patchStorageUri: "test://patches/1.patch",
        },
      ],
    });
    await expect(
      remote.listPatchesFromBase(base.id, { limit: 10 }),
    ).resolves.toEqual([expect.objectContaining({ bundle_id: target.id })]);
    await expect(remote.deleteBundles([base.id])).rejects.toMatchObject({
      status: 409,
    });
  });

  it("fails fast on a server that predates protocol 2, and refuses release filters no index serves", async () => {
    server.use(
      http.get(`${baseUrl}/old-server/version`, () =>
        HttpResponse.json({ error: "Not found" }, { status: 404 }),
      ),
    );
    await expect(
      standaloneRepository({
        baseUrl: `${baseUrl}/old-server`,
      }).core.listChannels(),
    ).rejects.toThrow("speaks admin API protocol 1, and this CLI needs 2");

    const response = await fetch(
      `${baseUrl}/hot-updater/admin/releases?v=2&channelId=x`,
    );
    expect(response.status).toBe(400);
  });
});

describe("Insights through a self-hosted server's admin API", () => {
  const offPath = "/no-insights";
  const withoutInsights = createHotUpdater({
    database: kyselyAdapter({ db: kysely, provider: "postgresql" }),
    plugins: [],
    clientAccess: "public",
  });

  beforeAll(() => {
    server.use(
      http.all(`${baseUrl}${offPath}/*`, ({ request }) =>
        invokeHandler(withoutInsights, request, offPath),
      ),
    );
  });

  it("reads events with the repository's headers, and a server without insights() says it is off", async () => {
    const on = standaloneRepository({
      baseUrl: `${baseUrl}/hot-updater/admin`,
    });
    const onResponse = await on.fetchAdmin("/events?limit=1");
    expect(onResponse.status).toBe(200);
    await expect(onResponse.json()).resolves.toMatchObject({ data: [] });

    const off = standaloneRepository({ baseUrl: `${baseUrl}${offPath}/admin` });
    const offResponse = await off.fetchAdmin("/events?limit=1");
    expect(offResponse.status).toBe(204);
    expect(offResponse.headers.get("x-hot-updater-insights")).toBe("disabled");
  });
});
