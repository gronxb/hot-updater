import {
  NIL_UUID,
  selectDesiredRelease,
  type ReleaseCatalog,
  type ReleaseSelectionInput,
} from "@hot-updater/core";
import type { BundleRow, ReleaseRow } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import { createBundleRowFixture } from "./databaseTestFixtures";
import type { HttpTestRequest } from "./httpTestClient";
import { releaseCatalogDownloadUrl } from "./releaseCatalogHttpFixtures";

type PublishedRelease = { bundle: BundleRow; release: ReleaseRow };
type Device = {
  -readonly [Key in keyof ReleaseSelectionInput]: ReleaseSelectionInput[Key];
};

// Model the state after a successful native activation. Selection uses the same
// production function as React Native; persistence and artifacts go through HTTP.
// Downloading bytes, restarting JS, and native crash recovery are separate E2Es.
export function setupReleaseCatalogLifecycleTests(options: {
  readCatalog: () => Promise<ReleaseCatalog>;
  publish: (
    suffix: string,
    patch?: Partial<ReleaseRow>,
  ) => Promise<PublishedRelease>;
  publishIncompatible: (suffix: string) => Promise<PublishedRelease>;
  update: (
    releaseId: string,
    patch: Record<string, unknown>,
  ) => Promise<unknown>;
  remove: (releaseId: string) => Promise<unknown>;
  request: HttpTestRequest;
}): void {
  const device = (minimumReleaseId = NIL_UUID): Device => ({
    builtInBundleId: minimumReleaseId,
    currentBundleId: minimumReleaseId,
    activeReleaseId: null,
    minimumReleaseId,
    cohort: "1",
    crashedBundleIds: [],
  });
  const refresh = async (previous: ReleaseCatalog) => {
    let next = previous;
    // Honor real server cache expiry; never replace the response with fixtures.
    await expect
      .poll(
        async () => {
          next = await options.readCatalog();
          return next.generation;
        },
        { interval: 100, timeout: 10_000 },
      )
      .toBeGreaterThan(previous.generation);
    expect(next.catalogId).toBe(previous.catalogId);
    expect(next.catalogHash).not.toBe(previous.catalogHash);
    return next;
  };
  const install = async (
    catalog: ReleaseCatalog,
    app: Device,
    target: PublishedRelease,
    status: "UPDATE" | "ROLLBACK",
  ) => {
    const desired = selectDesiredRelease(catalog, app);
    expect(desired).toMatchObject({
      kind: "BUNDLE",
      releaseId: target.release.id,
      bundleId: target.bundle.id,
      status,
      release: {
        message: target.release.message,
        shouldForceUpdate: target.release.should_force_update,
      },
    });
    const response = await options.request(
      `/artifacts/${desired!.bundleId}/from/${app.currentBundleId}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      fileHash: target.bundle.file_hash,
      fileUrl: releaseCatalogDownloadUrl(target.bundle.storage_uri),
    });
    // Advance only after verifying the selected artifact, then check again using
    // the newly active Release/Bundle rather than a fresh-install request.
    app.currentBundleId = desired!.bundleId;
    app.activeReleaseId = desired!.releaseId;
  };
  const useBuiltin = (catalog: ReleaseCatalog, app: Device) => {
    expect(selectDesiredRelease(catalog, app)).toEqual({
      kind: "BUILTIN",
      releaseId: null,
      bundleId: app.builtInBundleId,
      release: null,
      status: "ROLLBACK",
    });
    // BUILTIN has no server artifact or Release. The native binary owns it.
    app.currentBundleId = app.builtInBundleId;
    app.activeReleaseId = null;
  };
  const staysOn = (catalog: ReleaseCatalog, app: Device) => {
    expect(selectDesiredRelease(catalog, app)).toMatchObject({
      bundleId: app.currentBundleId,
      releaseId: app.activeReleaseId,
    });
  };

  describe("OTA lifecycle through HTTP and the client selector", () => {
    it("runs built-in → OTA A → OTA B → rollback A → built-in after policy changes", async () => {
      const app = device();
      const first = await options.publish("801");
      const second = await options.publish("802", {
        enabled: false,
        should_force_update: true,
      });
      let catalog = await options.readCatalog();
      await install(catalog, app, first, "UPDATE");
      staysOn(catalog, app);

      await options.update(second.release.id, { enabled: true });
      catalog = await refresh(catalog);
      await install(catalog, app, second, "UPDATE");
      staysOn(catalog, app);

      await options.update(second.release.id, { enabled: false });
      catalog = await refresh(catalog);
      await install(catalog, app, first, "ROLLBACK");
      staysOn(catalog, app);

      await options.update(first.release.id, { enabled: false });
      catalog = await refresh(catalog);
      useBuiltin(catalog, app);
      staysOn(catalog, app);
    }, 40_000);

    it("rolls a deleted active Release back to older OTA bytes, then to built-in", async () => {
      const app = device();
      const first = await options.publish("811");
      const second = await options.publish("812");
      let catalog = await options.readCatalog();
      await install(catalog, app, second, "UPDATE");

      await options.remove(second.release.id);
      catalog = await refresh(catalog);
      await install(catalog, app, first, "ROLLBACK");

      await options.remove(first.release.id);
      catalog = await refresh(catalog);
      useBuiltin(catalog, app);
      staysOn(catalog, app);
    }, 30_000);

    it("respects the native minimum on fresh install and rollback with or without a Release receipt", async () => {
      await options.publish("821");
      const current = await options.publish("823", { enabled: false });
      const app = device(createBundleRowFixture("822").id);
      const catalog = await options.readCatalog();
      // An enabled OTA older than this native binary cannot be installed.
      useBuiltin(catalog, app);
      for (const activeReleaseId of [current.release.id, null]) {
        app.currentBundleId = current.bundle.id;
        app.activeReleaseId = activeReleaseId;
        useBuiltin(catalog, app);
      }
      // The bundle at the native floor must never roll back below that floor.
      expect(
        selectDesiredRelease(catalog, {
          ...device(current.bundle.id),
          activeReleaseId: current.release.id,
        }),
      ).toBeNull();
    });

    it("re-evaluates cohort changes and rolls back even when the predecessor rollout is closed", async () => {
      const app = { ...device(), cohort: "staff" };
      const first = await options.publish("831", {
        rollout_cohort_count: 0,
        target_cohorts: ["staff"],
      });
      const second = await options.publish("832", {
        rollout_cohort_count: 0,
        target_cohorts: ["staff"],
      });
      const catalog = await options.readCatalog();
      await install(catalog, app, second, "UPDATE");
      app.cohort = "1";
      await install(catalog, app, first, "ROLLBACK");
      // Neither Release remains eligible, and there is no older safe OTA.
      useBuiltin(catalog, app);
      staysOn(catalog, app);
    });

    it("does not reinstall crashed OTAs after native recovery to a previous OTA or built-in", async () => {
      const app = device();
      const first = await options.publish("841");
      const second = await options.publish("842", { enabled: false });
      let catalog = await options.readCatalog();
      await install(catalog, app, first, "UPDATE");
      await options.update(second.release.id, { enabled: true });
      catalog = await refresh(catalog);
      await install(catalog, app, second, "UPDATE");

      // Model native recovery: B failed, so the next check runs from stable A
      // with B in crash history. B remains enabled on the server.
      app.currentBundleId = first.bundle.id;
      app.activeReleaseId = first.release.id;
      app.crashedBundleIds = [second.bundle.id];
      staysOn(catalog, app);

      // If no downloaded OTA is safe, native recovery starts the built-in app.
      app.currentBundleId = app.builtInBundleId;
      app.activeReleaseId = null;
      app.crashedBundleIds = [first.bundle.id, second.bundle.id];
      useBuiltin(catalog, app);
      staysOn(catalog, app);

      const fixed = await options.publish("843");
      catalog = await refresh(catalog);
      await install(catalog, app, fixed, "UPDATE");
      staysOn(catalog, app);
    }, 25_000);

    it("selects a compatible OTA and stays on it despite a newer incompatible Release", async () => {
      const app = device();
      const compatible = await options.publish("851");
      await options.publishIncompatible("852");
      const catalog = await options.readCatalog();
      await install(catalog, app, compatible, "UPDATE");
      staysOn(catalog, app);
    });
  });
}
