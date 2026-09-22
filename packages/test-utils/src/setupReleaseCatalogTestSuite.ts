import type { ArtifactInfo, ReleaseCatalog } from "@hot-updater/core";
import type {
  DatabaseChange,
  DatabaseCommitExpectation,
  ReleaseCatalogRow,
  ReleaseRow,
} from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createBundlePatchRowFixture,
  createBundleRowFixture,
  createChannelRowFixture,
  createReleaseRowFixture,
} from "./databaseTestFixtures";
import type { HttpTestClient, HttpTestRequestInit } from "./httpTestClient";
import {
  RELEASE_CATALOG_MANIFEST_URIS,
  releaseCatalogArtifact,
  releaseCatalogDownloadUrl as downloadUrl,
} from "./releaseCatalogHttpFixtures";
import { setupReleaseCatalogLifecycleTests } from "./releaseCatalogLifecycleTests";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const FALLBACK_POLICY = "BUILTIN_IF_ACTIVE_INELIGIBLE";
const channelKey = (channel: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(channel)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const jsonRequest = (method: string, body?: unknown): HttpTestRequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/**
 * Server conformance through HTTP only. The caller owns server/database/storage
 * setup. Lifecycle scenarios feed HTTP catalogs to the production client selector;
 * no database, compiler, or server implementation is invoked directly.
 */
export const setupReleaseCatalogTestSuite = (options: {
  readonly getClient: () => HttpTestClient;
}): void => {
  describe("Release Catalog HTTP contract", () => {
    let channelNamespace: string;
    let cleanup: DatabaseChange[];
    beforeEach(() => {
      // Keep long-lived server caches isolated without mocking their clock.
      channelNamespace = crypto.randomUUID();
      cleanup = [];
    });
    const request = (path: string, init?: HttpTestRequestInit) =>
      options.getClient().client(path, init);
    const admin = (path: string, init?: HttpTestRequestInit) =>
      options.getClient().admin(path, init);
    const adminJson = async (path: string, init?: HttpTestRequestInit) => {
      const response = await admin(path, init);
      const text = await response.text();
      expect(response.ok, `${init?.method ?? "GET"} ${path}: ${text}`).toBe(
        true,
      );
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      return JSON.parse(text);
    };
    const commit = async (changes: DatabaseChange[]) => {
      expect(
        await adminJson("/database/commit", jsonRequest("POST", { changes })),
      ).toEqual({ data: { committed: true } });
      for (const change of changes) {
        if (change.operation !== "insert") continue;
        if (change.model === "bundles" || change.model === "releases") {
          cleanup.push({
            model: change.model,
            operation: "delete",
            where: { id: change.row.id },
          });
        } else if (change.model === "bundlePatches") {
          cleanup.push({
            model: "bundlePatches",
            operation: "delete",
            where: { bundleId: change.row.bundle_id },
          });
        }
      }
    };
    afterEach(async () => {
      // Channels/Catalogs have no public Catalog delete API; the caller drops
      // the isolated test database after the suite. Remove reusable identities.
      const changes = cleanup.reverse();
      for (let offset = 0; offset < changes.length; offset += 10) {
        await commit(changes.slice(offset, offset + 10));
      }
    });

    for (const strategy of ["APP_VERSION", "FINGERPRINT"] as const) {
      describe(strategy, () => {
        const scope = (
          channel = "production",
          platform: "ios" | "android" = "ios",
          fingerprint = "fingerprint-a",
        ) => {
          channel = `${channel}-${channelNamespace}`;
          const encodedChannel = channelKey(channel);
          return {
            channel,
            channelId: createChannelRowFixture(channel).id,
            channelKey: encodedChannel,
            platform,
            fingerprint: strategy === "FINGERPRINT" ? fingerprint : null,
            key:
              strategy === "APP_VERSION"
                ? `v1:app-version:${platform}:${encodedChannel}`
                : `v1:fingerprint:${platform}:${encodedChannel}:${fingerprint}`,
          };
        };
        const catalogPath = (target = scope(), appVersion = "1.2.3") =>
          `/release-catalogs/${strategy === "APP_VERSION" ? "app-version" : "fingerprint"}/${target.platform}/${target.channelKey}/${strategy === "APP_VERSION" ? appVersion : target.fingerprint}`;
        const catalogRowPath = (target = scope()) =>
          `/release-catalogs/${encodeURIComponent(target.key)}`;
        const readCatalog = async (target = scope(), appVersion = "1.2.3") => {
          const response = await request(catalogPath(target, appVersion));
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toBe(
            "application/vnd.hot-updater.release-catalog+json; version=1",
          );
          expect(response.headers.get("cache-control")).toBe(
            "public, max-age=0, s-maxage=5",
          );
          const catalog = (await response.json()) as ReleaseCatalog;
          expect(catalog).toMatchObject({
            schemaVersion: 1,
            scopeKey: target.key,
            fallbackPolicy: FALLBACK_POLICY,
            catalogId: expect.any(String),
            catalogHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          });
          return catalog;
        };
        const publish = async (
          suffix: string,
          patch: Partial<ReleaseRow> = {},
          target = scope(),
        ) => {
          const channel = { id: target.channelId, name: target.channel };
          await adminJson(
            "/channels",
            jsonRequest("POST", { row: channel, onConflict: "returnExisting" }),
          );
          const bundle = {
            ...createBundleRowFixture(suffix),
            platform: target.platform,
            asset_base_storage_uri: "storage://test-bucket/assets",
          };
          const changes: DatabaseChange[] = [];
          if (patch.bundle_id === undefined) {
            await adminJson(
              "/bundles",
              jsonRequest("POST", {
                id: bundle.id,
                platform: bundle.platform,
                manifestFileHash: bundle.manifest_file_hash,
                manifestStorageUri: bundle.manifest_storage_uri,
                assetBaseStorageUri: bundle.asset_base_storage_uri,
                gitCommitHash: null,
                metadata: bundle.metadata,
              }),
            );
            cleanup.push({
              model: "bundles",
              operation: "delete",
              where: { id: bundle.id },
            });
          }
          const release: ReleaseRow = {
            ...createReleaseRowFixture(suffix, bundle, channel),
            strategy,
            scope_key: target.key,
            target_app_version: strategy === "APP_VERSION" ? "*" : null,
            fingerprint_hash: target.fingerprint,
            ...patch,
          };
          changes.push({
            model: "releases",
            operation: "insert",
            row: release,
          });
          const existing = await admin(catalogRowPath(target));
          if (existing.status === 404) {
            await existing.text();
            // Bootstrap a valid empty Catalog through the public commit API.
            // Rebuild below must compile the actual Releases on the server.
            const payload = JSON.stringify(
              strategy === "APP_VERSION"
                ? {
                    fallbackPolicy: FALLBACK_POLICY,
                    releaseDescriptors: [],
                    schemaVersion: 1,
                    segments: [],
                    strategy,
                  }
                : {
                    fallbackPolicy: FALLBACK_POLICY,
                    releaseDescriptors: [],
                    releaseIndexes: [],
                    rollbackReleaseIndexes: [],
                    schemaVersion: 1,
                    strategy,
                  },
            );
            const digest = await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(payload),
            );
            const hash = [...new Uint8Array(digest)]
              .map((byte) => byte.toString(16).padStart(2, "0"))
              .join("");
            changes.push({
              model: "releaseCatalogs",
              operation: "put",
              row: {
                catalog_id: "00000000-0000-7000-8000-000000009999",
                scope_key: target.key,
                channel_id: target.channelId,
                channel_key: target.channelKey,
                platform: target.platform,
                fingerprint_hash: target.fingerprint,
                strategy,
                generation: 1,
                is_tombstone: true,
                payload,
                catalog_hash: `sha256:${hash}`,
                byte_size: new TextEncoder().encode(payload).byteLength,
                updated_at_ms: 1,
              },
            });
          } else {
            expect(existing.status).toBe(200);
            await existing.text();
          }
          await commit(changes);
          await adminJson(
            `${catalogRowPath(target)}/rebuild`,
            jsonRequest("POST"),
          );
          return { bundle, release };
        };
        const update = (releaseId: string, patch: Record<string, unknown>) =>
          adminJson(`/releases/${releaseId}`, jsonRequest("PATCH", { patch }));

        setupReleaseCatalogLifecycleTests({
          readCatalog,
          publish,
          publishIncompatible: (suffix) =>
            strategy === "APP_VERSION"
              ? publish(suffix, { target_app_version: ">=1.2.4" })
              : publish(
                  suffix,
                  {},
                  scope("production", "ios", "fingerprint-b"),
                ),
          update,
          remove: async (id) => {
            // Public hard deletion requires disabling the Release first.
            await update(id, { enabled: false });
            await adminJson(
              `/releases/${id}?confirm=${id}&expectedRevision=2`,
              jsonRequest("DELETE"),
            );
            expect((await admin(`/releases/${id}`)).status).toBe(404);
            cleanup = cleanup.filter(
              (change) =>
                !(
                  change.model === "releases" &&
                  change.operation === "delete" &&
                  change.where.id === id
                ),
            );
          },
          request,
        });

        it("pages all scoped Releases including disabled rows with an exclusive cursor", async () => {
          const first = await publish("701");
          const disabled = await publish("702", { enabled: false });
          await publish("703", {}, scope("other"));
          const path = `/releases?scopeKey=${encodeURIComponent(scope().key)}&limit=1`;
          expect((await adminJson(path)).data).toEqual([first.release]);
          expect(
            (await adminJson(`${path}&afterReleaseId=${first.release.id}`))
              .data,
          ).toEqual([disabled.release]);
          expect(
            (await adminJson(`${path}&afterReleaseId=${disabled.release.id}`))
              .data,
          ).toEqual([]);
        });

        for (const model of ["releases", "releaseCatalogs"] as const) {
          it.each(["stale", "absent", "missing"] as const)(
            `rejects a %s ${model} expectation without changing any model`,
            async (condition) => {
              const current = await publish("711");
              const catalog = (await adminJson(catalogRowPath()))
                .data as ReleaseCatalogRow;
              const releaseExpectation = {
                model: "releases",
                id: current.release.id,
                revision: 1,
              } as const;
              const catalogExpectation = {
                model: "releaseCatalogs",
                scopeKey: catalog.scope_key,
                generation: catalog.generation,
              } as const;
              const key =
                model === "releases" ? current.release.id : catalog.scope_key;
              const version = model === "releases" ? 1 : catalog.generation;
              const expectedVersion =
                condition === "absent" ? null : version + 1;
              const expectedKey =
                condition === "missing"
                  ? model === "releases"
                    ? "00000000-0000-7000-8000-000000009999"
                    : `${key}:missing`
                  : key;
              const expectation: DatabaseCommitExpectation =
                model === "releases"
                  ? { model, id: expectedKey, revision: expectedVersion }
                  : {
                      model,
                      scopeKey: expectedKey,
                      generation: expectedVersion,
                    };
              const result = await adminJson(
                "/database/commit",
                jsonRequest("POST", {
                  expectations: [
                    model === "releases"
                      ? catalogExpectation
                      : releaseExpectation,
                    expectation,
                  ],
                  changes: [
                    {
                      model: "bundles",
                      operation: "update",
                      where: { id: current.bundle.id },
                      update: {
                        manifest_storage_uri: "storage://should-not-be-written",
                      },
                    },
                    {
                      model: "releases",
                      operation: "update",
                      where: { id: current.release.id },
                      update: { message: "should not be written", revision: 2 },
                    },
                    {
                      model: "releaseCatalogs",
                      operation: "put",
                      row: { ...catalog, generation: catalog.generation + 1 },
                    },
                  ],
                }),
              );
              expect(result.data).toEqual({
                committed: false,
                conflict: {
                  changeIndex: -1,
                  reason: "version_conflict",
                  model,
                  key: expectedKey,
                  expectedVersion,
                  actualVersion: condition === "missing" ? null : version,
                },
              });
              expect(
                (await adminJson(`/releases/${current.release.id}`)).data,
              ).toEqual(current.release);
              expect((await adminJson(catalogRowPath())).data).toEqual(catalog);
              const artifact = await request(
                `/artifacts/v1/${current.bundle.id}/from/${NIL_UUID}`,
              );
              expect(artifact.status).toBe(200);
              expect(await artifact.json()).toMatchObject({
                manifestUrl: downloadUrl(current.bundle.manifest_storage_uri),
              });
            },
          );

          it(`allows only one concurrent writer for a ${model} expectation`, async () => {
            const current = await publish("721");
            const catalog = (await adminJson(catalogRowPath()))
              .data as ReleaseCatalogRow;
            const expectation: DatabaseCommitExpectation =
              model === "releases"
                ? { model, id: current.release.id, revision: 1 }
                : {
                    model,
                    scopeKey: catalog.scope_key,
                    generation: catalog.generation,
                  };
            const results = await Promise.all(
              ["first", "second"].map((message) =>
                adminJson(
                  "/database/commit",
                  jsonRequest("POST", {
                    expectations: [expectation],
                    changes: [
                      {
                        model: "releases",
                        operation: "update",
                        where: { id: current.release.id },
                        update: { message, revision: 2 },
                      },
                      {
                        model: "releaseCatalogs",
                        operation: "put",
                        row: {
                          ...catalog,
                          generation: catalog.generation + 1,
                          updated_at_ms: message === "first" ? 1 : 2,
                        },
                      },
                    ],
                  }),
                ),
              ),
            );
            const winners = results.flatMap((result, index) =>
              result.data.committed ? [index] : [],
            );
            expect(winners).toHaveLength(1);
            expect(results[1 - winners[0]!]!.data).toMatchObject({
              committed: false,
              conflict: {
                changeIndex: -1,
                reason: "version_conflict",
                model,
                expectedVersion: model === "releases" ? 1 : catalog.generation,
                actualVersion:
                  model === "releases" ? 2 : catalog.generation + 1,
              },
            });
            expect(
              (await adminJson(`/releases/${current.release.id}`)).data,
            ).toMatchObject({
              revision: 2,
              message: ["first", "second"][winners[0]!],
            });
            expect((await adminJson(catalogRowPath())).data).toMatchObject({
              generation: catalog.generation + 1,
              updated_at_ms: winners[0]! + 1,
            });
          });
        }

        it("keeps legacy embedded rows readable while excluding them from compiled Catalogs", async () => {
          const current = await publish("731");
          const embedded = await publish("732", {
            kind: "EMBEDDED",
            bundle_id: null,
            operation: "ROLLBACK",
          });
          expect(
            (await readCatalog()).releases.map((row) => row.releaseId),
          ).toEqual([current.release.id]);
          expect(
            (
              await adminJson(
                `/releases?scopeKey=${encodeURIComponent(scope().key)}&limit=10`,
              )
            ).data,
          ).toEqual([current.release, embedded.release]);
          expect(
            (await adminJson(`/releases/${embedded.release.id}`)).data,
          ).toEqual(embedded.release);
        });

        it("hard deletes a Release, rebuilds its Catalog, and retains Bundle bytes", async () => {
          const current = await publish("741", { enabled: false });
          await adminJson(
            `/releases/${current.release.id}?confirm=${current.release.id}&expectedRevision=1`,
            jsonRequest("DELETE"),
          );
          cleanup = cleanup.filter(
            (change) =>
              !(
                change.model === "releases" &&
                change.operation === "delete" &&
                change.where.id === current.release.id
              ),
          );
          expect((await admin(`/releases/${current.release.id}`)).status).toBe(
            404,
          );
          expect(await readCatalog()).toMatchObject({
            releases: [],
            rollbackReleases: [],
          });
          const artifact = await request(
            `/artifacts/v1/${current.bundle.id}/from/${NIL_UUID}`,
          );
          expect(artifact.status).toBe(200);
          expect(await artifact.json()).toMatchObject({
            manifestUrl: downloadUrl(current.bundle.manifest_storage_uri),
          });
        });

        it("serves enabled Releases newest first and resolves artifacts by Bundle identity", async () => {
          const first = await publish("101");
          const { bundle, release } = await publish("102", {
            message: "업데이트",
            should_force_update: true,
          });
          await publish("103", { enabled: false });
          const catalog = await readCatalog();
          expect(catalog.releases.map((item) => item.releaseId)).toEqual([
            release.id,
            first.release.id,
          ]);
          expect(catalog.releases[0]).toMatchObject({
            bundleId: bundle.id,
            message: "업데이트",
            shouldForceUpdate: true,
          });
          const response = await request(
            `/artifacts/v1/${bundle.id}/from/${NIL_UUID}`,
          );
          expect(response.status).toBe(200);
          expect(response.headers.get("cache-control")).toBe(
            "private, no-store",
          );
          expect(await response.json()).toEqual(releaseCatalogArtifact(bundle));
          expect(
            (await request(`/artifacts/v1/${release.id}/from/${NIL_UUID}`))
              .status,
          ).toBe(404);
        });

        it("isolates channels, platforms, and update strategies", async () => {
          const stable = await publish("111");
          const beta = await publish("112", {}, scope("beta / 한글"));
          const android = await publish(
            "113",
            {},
            scope("production", "android"),
          );
          for (const [target, release] of [
            [scope(), stable.release],
            [scope("beta / 한글"), beta.release],
            [scope("production", "android"), android.release],
          ] as const) {
            expect(
              (await readCatalog(target)).releases.map(
                (item) => item.releaseId,
              ),
            ).toEqual([release.id]);
          }
          const otherPath =
            strategy === "APP_VERSION"
              ? `/release-catalogs/fingerprint/ios/${scope().channelKey}/fingerprint-a`
              : `/release-catalogs/app-version/ios/${scope().channelKey}/1.2.3`;
          expect((await request(otherPath)).status).toBe(404);
        });

        it("returns an uncached 404 for an unknown scope", async () => {
          const response = await request(catalogPath());
          expect(response.status).toBe(404);
          expect(response.headers.get("cache-control")).toBe(
            "private, no-store",
          );
          await publish("121");
          expect((await readCatalog()).releases).toHaveLength(1);
        });

        it("preserves rollout and named cohort policy without server-side cohort selection", async () => {
          const stable = await publish("131");
          const partial = await publish("132", { rollout_cohort_count: 500 });
          const targeted = await publish("133", {
            rollout_cohort_count: 0,
            target_cohorts: ["qa"],
          });
          const catalog = await readCatalog();
          expect(
            catalog.releases.map(
              ({ releaseId, rolloutCohortCount, targetCohorts }) => ({
                releaseId,
                rolloutCohortCount,
                targetCohorts,
              }),
            ),
          ).toEqual([
            {
              releaseId: targeted.release.id,
              rolloutCohortCount: 0,
              targetCohorts: ["qa"],
            },
            {
              releaseId: partial.release.id,
              rolloutCohortCount: 500,
              targetCohorts: [],
            },
            {
              releaseId: stable.release.id,
              rolloutCohortCount: 1000,
              targetCohorts: [],
            },
          ]);
        });

        it("keeps the newest Release policy when Bundle bytes are reused", async () => {
          const first = await publish("141");
          const second = await publish("142", {
            bundle_id: first.bundle.id,
            message: "new policy",
          });
          const catalog = await readCatalog();
          expect(catalog.releases[0]).toMatchObject({
            releaseId: second.release.id,
            bundleId: first.bundle.id,
            message: "new policy",
          });
          expect(
            catalog.rollbackReleases?.map((item) => item.releaseId),
          ).toEqual([second.release.id, first.release.id]);
        });

        it("revalidates immutable responses against the persisted Catalog", async () => {
          await publish("161");
          const response = await request(catalogPath());
          const catalog = (await response.json()) as ReleaseCatalog;
          const etag = response.headers.get("etag")!;
          expect(etag).toMatch(/^"sha256:[0-9a-f]{64}"$/);
          const revalidated = await request(catalogPath(), {
            headers: { "if-none-match": etag },
          });
          expect(revalidated.status).toBe(304);
          expect(await revalidated.text()).toBe("");
          const persisted = await adminJson(catalogRowPath());
          expect(persisted.data).toMatchObject({
            catalog_id: catalog.catalogId,
            catalog_hash: catalog.catalogHash,
            generation: catalog.generation,
          });
          const rebuild = await adminJson(
            `${catalogRowPath()}/rebuild`,
            jsonRequest("POST"),
          );
          expect(rebuild.data.changed).toBe(false);
          expect(rebuild.data.catalog.generation).toBe(catalog.generation);
        });

        it("refreshes a cached Catalog after HTTP policy changes and retains rollback candidates", async () => {
          const predecessor = await publish("171", { rollout_cohort_count: 0 });
          const current = await publish("172");
          const response = await request(catalogPath());
          const previous = (await response.json()) as ReleaseCatalog;
          await update(current.release.id, { enabled: false });
          let refreshed: ReleaseCatalog | undefined;
          await expect
            .poll(
              async () => {
                const next = await request(catalogPath(), {
                  headers: { "if-none-match": response.headers.get("etag")! },
                });
                const text = await next.text();
                if (next.status === 200)
                  refreshed = JSON.parse(text) as ReleaseCatalog;
                return next.status;
              },
              { interval: 100, timeout: 10_000 },
            )
            .toBe(200);
          expect(refreshed).toMatchObject({
            catalogId: previous.catalogId,
            generation: previous.generation + 1,
            releases: [],
          });
          expect(refreshed?.catalogHash).not.toBe(previous.catalogHash);
          expect(refreshed?.rollbackReleases).toEqual([
            expect.objectContaining({
              releaseId: predecessor.release.id,
              bundleId: predecessor.bundle.id,
              rolloutCohortCount: 0,
            }),
          ]);
        }, 15_000);

        it("publishes an empty tombstone after the last Release is disabled", async () => {
          const current = await publish("181");
          await update(current.release.id, { enabled: false });
          expect(await readCatalog()).toMatchObject({
            releases: [],
            rollbackReleases: [],
            fallbackPolicy: FALLBACK_POLICY,
          });
          expect((await adminJson(catalogRowPath())).data.is_tombstone).toBe(
            true,
          );
        });

        it("returns HTTP 409 for stale policy revisions without changing the persisted Catalog", async () => {
          const current = await publish("191");
          await update(current.release.id, { message: "new policy" });
          const before = await adminJson(catalogRowPath());
          const response = await admin(
            `/releases/${current.release.id}`,
            jsonRequest("PATCH", {
              expectedRevision: 1,
              patch: { enabled: false },
            }),
          );
          expect(response.status).toBe(409);
          expect(await response.json()).toMatchObject({
            code: "VERSION_CONFLICT",
          });
          expect(await adminJson(catalogRowPath())).toEqual(before);
          expect(
            (await adminJson(`/releases/${current.release.id}`)).data,
          ).toMatchObject({
            enabled: true,
            revision: 2,
            message: "new policy",
          });
        });

        if (strategy === "APP_VERSION") {
          it.each([
            "channelId",
            "platform",
            "enabled",
            "bundleId",
            "targetAppVersion",
          ] as const)(
            "applies the %s filter before limiting Release results",
            async (filter) => {
              const first = await publish("751", {
                target_app_version: "1.0.0",
                enabled: false,
              });
              const second = await publish("752", {
                bundle_id: first.bundle.id,
                target_app_version: "1.0.0",
                enabled: false,
              });
              const target =
                filter === "channelId"
                  ? scope("other")
                  : filter === "platform"
                    ? scope("production", "android")
                    : scope();
              await publish(
                "753",
                {
                  target_app_version:
                    filter === "targetAppVersion" ? "2.0.0" : "1.0.0",
                  enabled: filter === "enabled",
                  ...(["channelId", "enabled", "targetAppVersion"].includes(
                    filter,
                  )
                    ? { bundle_id: first.bundle.id }
                    : {}),
                },
                target,
              );
              const value = {
                channelId: scope().channelId,
                platform: "ios",
                enabled: "false",
                bundleId: first.bundle.id,
                targetAppVersion: "1.0.0",
              }[filter];
              const path = `/releases?${filter}=${encodeURIComponent(value)}&limit=1`;
              expect((await adminJson(path)).data).toEqual([second.release]);
              expect(
                (
                  await adminJson(
                    `${path}&beforeReleaseId=${second.release.id}`,
                  )
                ).data,
              ).toEqual([first.release]);
              expect(
                (await adminJson(`${path}&beforeReleaseId=${first.release.id}`))
                  .data,
              ).toEqual([]);
              expect(
                (await adminJson(`${path}&afterReleaseId=${first.release.id}`))
                  .data,
              ).toEqual([second.release]);
            },
          );

          it("serves the newest Release among 200 distinct compatible version ranges", async () => {
            const first = await publish("400", {
              target_app_version: ">=0.0.0",
            });
            const channel = createChannelRowFixture(scope().channel);
            // Keep each HTTP commit within provider transaction limits, then
            // exercise one server rebuild over the complete Release history.
            for (let start = 1; start < 200; start += 10) {
              const changes: DatabaseChange[] = [];
              for (
                let index = start;
                index < Math.min(start + 10, 200);
                index++
              ) {
                const suffix = String(400 + index);
                const bundle = createBundleRowFixture(suffix);
                const release = {
                  ...createReleaseRowFixture(suffix, bundle, channel),
                  scope_key: first.release.scope_key,
                  target_app_version: `>=0.${index}.0`,
                };
                changes.push(
                  { model: "bundles", operation: "insert", row: bundle },
                  { model: "releases", operation: "insert", row: release },
                );
              }
              await commit(changes);
            }
            await adminJson(`${catalogRowPath()}/rebuild`, jsonRequest("POST"));
            const catalog = await readCatalog(scope(), "1.0.0");
            expect(catalog.releases[0]?.bundleId).toBe(
              createBundleRowFixture("599").id,
            );
            expect(catalog.rollbackReleases).toHaveLength(200);
          });

          it("keeps version projections separate in the HTTP cache", async () => {
            const first = await publish("231", {
              target_app_version: "^1.0.0",
            });
            const second = await publish("232", {
              target_app_version: "^2.0.0",
            });
            for (const [version, releaseId] of [
              ["1.2.3", first.release.id],
              ["2.1.0", second.release.id],
              ["1.2.3", first.release.id],
            ]) {
              expect(
                (await readCatalog(scope(), version)).releases.map(
                  (release) => release.releaseId,
                ),
              ).toEqual([releaseId]);
            }
          });
          it.each([
            ["*", "1.2.3", true],
            ["1.2.3", "1.2.3", true],
            ["^1.0.0", "1.2.3", true],
            [">=1.0.0 <2.0.0", "2.0.0", false],
            ["~1.2.0", "1.3.0", false],
            ["^1.0.0 || ^3.0.0", "3.1.0", true],
            [">= 5.7.0 <= 5.7.4", "5.7.3", true],
            [">= 5.7.0 <= 5.7.4", "5.7.5", false],
          ])(
            "projects %s for app version %s (compatible: %s)",
            async (range, version, compatible) => {
              const current = await publish("201", {
                target_app_version: range,
              });
              expect(
                (await readCatalog(scope(), version)).releases.map(
                  (item) => item.releaseId,
                ),
              ).toEqual(compatible ? [current.release.id] : []);
            },
          );
          it("rejects noncanonical versions and unsupported platforms with HTTP 400", async () => {
            await publish("211");
            for (const path of [
              catalogPath(scope(), "v1.2"),
              catalogPath().replace("/ios/", "/windows/"),
            ]) {
              const response = await request(path);
              expect(response.status).toBe(400);
              expect(response.headers.get("cache-control")).toBe(
                "private, no-store",
              );
            }
          });
        } else {
          it("pages Catalogs in scope order with an exclusive cursor and limit", async () => {
            const first = scope("production", "ios", "paging-a");
            const second = scope("production", "ios", "paging-b");
            await publish("761", {}, second);
            await publish("762", {}, first);
            const prefix = first.key.slice(0, -1);
            expect(
              (
                await adminJson(
                  `/release-catalogs?limit=1&afterScopeKey=${encodeURIComponent(prefix)}`,
                )
              ).data,
            ).toEqual([(await adminJson(catalogRowPath(first))).data]);
            expect(
              (
                await adminJson(
                  `/release-catalogs?limit=1&afterScopeKey=${encodeURIComponent(first.key)}`,
                )
              ).data,
            ).toEqual([(await adminJson(catalogRowPath(second))).data]);
          });

          it("isolates exact fingerprints", async () => {
            const first = await publish("221");
            const second = await publish(
              "222",
              {},
              scope("production", "ios", "fingerprint-b"),
            );
            expect(
              (await readCatalog()).releases.map((item) => item.releaseId),
            ).toEqual([first.release.id]);
            expect(
              (
                await readCatalog(scope("production", "ios", "fingerprint-b"))
              ).releases.map((item) => item.releaseId),
            ).toEqual([second.release.id]);
            expect(
              (
                await request(
                  catalogPath(scope("production", "ios", "unknown")),
                )
              ).status,
            ).toBe(404);
          });
        }
      });
    }

    it.each(["small", "large"] as const)(
      "retains original and patch plans alongside a %s optional archive",
      async (size) => {
        const base = createBundleRowFixture("301");
        const target = {
          ...createBundleRowFixture("302"),
          manifest_storage_uri: RELEASE_CATALOG_MANIFEST_URIS[size],
          manifest_file_hash: "manifest-hash",
          asset_base_storage_uri: "storage://test-bucket/assets",
        };
        const patch = {
          ...createBundlePatchRowFixture("302", target.id, base.id),
          byte_size: 10,
        };
        await commit([
          { model: "bundles", operation: "insert", row: base },
          { model: "bundles", operation: "insert", row: target },
          { model: "bundlePatches", operation: "insert", row: patch },
        ]);
        const response = await request(
          `/artifacts/v1/${target.id}/from/${base.id}`,
        );
        expect(response.status).toBe(200);
        const artifact = (await response.json()) as ArtifactInfo;
        const original = releaseCatalogArtifact(target);
        const archiveUrl = downloadUrl(
          target.manifest_storage_uri.replace("manifest.json", "bundle.tar.br"),
        );
        expect(artifact).toEqual({
          ...original,
          archiveUrl,
          assets: {
            "index.ios.bundle": {
              ...original.assets["index.ios.bundle"],
              patch: {
                algorithm: "bsdiff",
                baseBundleId: base.id,
                baseFileHash: patch.base_file_hash,
                patchFileHash: patch.patch_file_hash,
                patchUrl: downloadUrl(patch.patch_storage_uri),
                byteSize: patch.byte_size,
              },
            },
          },
        });
        const freshInstall = await request(
          `/artifacts/v1/${target.id}/from/${NIL_UUID}`,
        );
        expect(freshInstall.status).toBe(200);
        expect(await freshInstall.json()).toEqual({ ...original, archiveUrl });
      },
    );
  });
};
