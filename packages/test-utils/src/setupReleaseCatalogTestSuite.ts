import type { ArtifactInfo, ReleaseCatalog } from "@hot-updater/core";
import type {
  BundleRow,
  ReleaseCatalogRow,
  ReleaseRow,
} from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createAdminApiTestClient,
  jsonRequest,
  toDeployBundle,
} from "./adminApiTestClient";
import {
  createBundlePatchRowFixture,
  createBundleRowFixture,
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

/** The policy fields a test sets, as a release row names them. */
type ReleasePatch = Partial<
  Pick<
    ReleaseRow,
    | "bundle_id"
    | "enabled"
    | "message"
    | "rollout_cohort_count"
    | "should_force_update"
    | "target_app_version"
    | "target_cohorts"
  >
>;

/**
 * Server conformance through HTTP only, on admin API protocol 2. The caller
 * owns server, database, and storage setup. Releases are written with
 * `POST /releases` and changed with `PATCH /releases/:id`; lifecycle scenarios
 * feed HTTP catalogs to the production client selector. Each test deletes
 * what it wrote, so a long-lived server can run the suite again.
 */
export const setupReleaseCatalogTestSuite = (options: {
  readonly getClient: () => HttpTestClient;
}): void => {
  describe("Release Catalog HTTP contract", () => {
    let channelNamespace: string;
    const api = createAdminApiTestClient(options.getClient);
    const { admin, adminJson } = api;
    beforeEach(() => {
      // Keep long-lived server caches isolated without mocking their clock.
      channelNamespace = crypto.randomUUID();
    });
    afterEach(async () => {
      await api.cleanup();
    });
    const request = (path: string, init?: HttpTestRequestInit) =>
      options.getClient().client(path, init);
    // The storage fixtures serve each suffix's manifest for its fixture id,
    // and lifecycle tests compare those ids with a native minimum; each test
    // deletes its bundles, so the next one can deploy the same ids.
    const bundleRow = (suffix: string): BundleRow =>
      createBundleRowFixture(suffix);

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
        /** Deploys a new bundle, or a stored one named by `bundle_id`, into `target`. */
        const publish = async (
          suffix: string,
          patch: ReleasePatch = {},
          target = scope(),
        ) => {
          const bundle: BundleRow = {
            ...bundleRow(suffix),
            platform: target.platform,
            asset_base_storage_uri: "storage://test-bucket/assets",
          };
          const policy = {
            channel: target.channel,
            enabled: patch.enabled ?? true,
            fingerprintHash: target.fingerprint,
            message:
              patch.message === undefined ? `release-${suffix}` : patch.message,
            shouldForceUpdate: patch.should_force_update ?? false,
            targetAppVersion:
              strategy === "APP_VERSION"
                ? (patch.target_app_version ?? "*")
                : null,
            ...(patch.rollout_cohort_count === undefined
              ? {}
              : { rolloutCohortCount: patch.rollout_cohort_count }),
            ...(patch.target_cohorts === undefined
              ? {}
              : { targetCohorts: [...patch.target_cohorts] }),
          };
          const release = await api.deploy(
            patch.bundle_id === undefined || patch.bundle_id === null
              ? { bundle: toDeployBundle(bundle), release: policy }
              : { bundleId: patch.bundle_id, release: policy },
          );
          return {
            bundle:
              patch.bundle_id === undefined || patch.bundle_id === null
                ? bundle
                : { ...bundle, id: patch.bundle_id },
            release,
          };
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
            api.forget(id);
          },
          request,
        });

        it("pages all scoped Releases including disabled rows with an exclusive cursor", async () => {
          const first = await publish("701");
          const disabled = await publish("702", { enabled: false });
          await publish("703", {}, scope("other"));
          const path = `/releases?scopeKey=${encodeURIComponent(scope().key)}&limit=1&order=asc`;
          const page1 = await adminJson(path);
          expect(page1.data).toEqual([first.release]);
          expect(page1.next).toBe(first.release.id);
          const page2 = await adminJson(`${path}&cursor=${page1.next}`);
          expect(page2.data).toEqual([disabled.release]);
          expect(
            (await adminJson(`${path}&cursor=${page2.next}`)).data,
          ).toEqual([]);
          expect(
            (
              await adminJson(
                `/releases?scopeKey=${encodeURIComponent(scope().key)}&enabled=false`,
              )
            ).data,
          ).toEqual([disabled.release]);
        });

        it("lets one of two concurrent policy changes at the same revision win", async () => {
          const current = await publish("721");
          const catalog = (await adminJson(catalogRowPath()))
            .data as ReleaseCatalogRow;
          const responses = await Promise.all(
            ["first", "second"].map((message) =>
              admin(
                `/releases/${current.release.id}`,
                jsonRequest("PATCH", {
                  expectedRevision: 1,
                  patch: { message },
                }),
              ),
            ),
          );
          const statuses = responses.map(({ status }) => status).sort();
          expect(statuses).toEqual([200, 409]);
          const winner = responses.findIndex(({ status }) => status === 200);
          const loser = responses[1 - winner]!;
          expect(await loser.json()).toMatchObject({
            code: "VERSION_CONFLICT",
          });
          await responses[winner]!.text();
          expect(
            (await adminJson(`/releases/${current.release.id}`)).data,
          ).toMatchObject({
            revision: 2,
            message: ["first", "second"][winner],
          });
          expect((await adminJson(catalogRowPath())).data).toMatchObject({
            generation: catalog.generation + 1,
          });
        });

        it("hard deletes a Release, rebuilds its Catalog, and retains Bundle bytes", async () => {
          const current = await publish("741", { enabled: false });
          await adminJson(
            `/releases/${current.release.id}?confirm=${current.release.id}&expectedRevision=1`,
            jsonRequest("DELETE"),
          );
          api.forget(current.release.id);
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
          it("pages each release filter set by key, newest first", async () => {
            const first = await publish("751", { enabled: false });
            const second = await publish("752", {
              bundle_id: first.bundle.id,
              enabled: false,
            });
            const third = await publish("753");
            const elsewhere = await publish(
              "754",
              { bundle_id: first.bundle.id },
              scope("other"),
            );
            await publish("755", {}, scope("production", "android"));
            const { data: channel } = await adminJson(
              `/channels?name=${encodeURIComponent(scope().channel)}`,
            );
            /** Every page of one filter set, one release per page. */
            const pages = async (query: string) => {
              const ids: string[] = [];
              let cursor: string | undefined;
              do {
                const page = (await adminJson(
                  `/releases?${query}&limit=1${cursor === undefined ? "" : `&cursor=${cursor}`}`,
                )) as { data: ReleaseRow[]; next?: string };
                ids.push(...page.data.map(({ id }) => id));
                cursor = page.next;
              } while (cursor !== undefined);
              return ids;
            };
            const newestFirst = (
              ...published: { readonly release: ReleaseRow }[]
            ) =>
              published
                .map(({ release }) => release.id)
                .sort()
                .reverse();
            const byChannel = `channelId=${channel.id}&platform=ios`;

            expect(await pages(byChannel)).toEqual(
              newestFirst(first, second, third),
            );
            expect(await pages(`${byChannel}&enabled=false`)).toEqual(
              newestFirst(first, second),
            );
            expect(await pages(`bundleId=${first.bundle.id}`)).toEqual(
              newestFirst(first, second, elsewhere),
            );
            expect(
              await pages(
                `scopeKey=${encodeURIComponent(scope().key)}&enabled=true`,
              ),
            ).toEqual(newestFirst(third));
            expect(
              (await admin(`/releases?platform=ios&enabled=false`)).status,
            ).toBe(400);
          });

          it("serves the newest Release among 200 distinct compatible version ranges", async () => {
            await publish("400", { target_app_version: ">=0.0.0" });
            // One deploy per release: a batch changes each scope once, and
            // each deploy compiles the scope's catalog from all its releases.
            for (let index = 1; index < 200; index++) {
              await publish(String(400 + index), {
                target_app_version: `>=0.${index}.0`,
              });
            }
            const catalog = await readCatalog(scope(), "1.0.0");
            expect(catalog.releases[0]?.bundleId).toBe(bundleRow("599").id);
            expect(catalog.rollbackReleases).toHaveLength(200);
          }, 180_000);

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
            const page1 = await adminJson(
              `/release-catalogs?limit=1&order=asc&cursor=${encodeURIComponent(prefix)}`,
            );
            expect(page1.data).toEqual([
              (await adminJson(catalogRowPath(first))).data,
            ]);
            expect(page1.next).toBe(first.key);
            expect(
              (
                await adminJson(
                  `/release-catalogs?limit=1&order=asc&cursor=${encodeURIComponent(page1.next)}`,
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
        const channel = `artifacts-${channelNamespace}`;
        const policy = {
          channel,
          enabled: false,
          fingerprintHash: null,
          message: null,
          shouldForceUpdate: false,
          targetAppVersion: "*",
        };
        const base = bundleRow("301");
        const target = {
          ...bundleRow("302"),
          manifest_storage_uri: RELEASE_CATALOG_MANIFEST_URIS[size],
          manifest_file_hash: "manifest-hash",
          asset_base_storage_uri: "storage://test-bucket/assets",
        };
        const patch = {
          ...createBundlePatchRowFixture("302", target.id, base.id),
          byte_size: 10,
        };
        await api.deploy({ bundle: toDeployBundle(base), release: policy });
        await api.deploy({
          bundle: {
            ...toDeployBundle(target),
            patches: [
              {
                baseBundleId: base.id,
                baseFileHash: patch.base_file_hash,
                byteSize: patch.byte_size,
                patchFileHash: patch.patch_file_hash,
                patchStorageUri: patch.patch_storage_uri,
              },
            ],
          },
          release: policy,
        });
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
