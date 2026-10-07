import {
  isUUIDv7,
  type AppReadyResult,
  type BundleDownloadedInfo,
  type UpdateError,
} from "@hot-updater/protocol";
import {
  type ClientPluginTestRequest,
  type ClientPluginTestStorage,
  createTestStorage,
  setupClientPlugin,
} from "@hot-updater/test-utils/react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { insights, type InsightsOptions, type InsightsUser } from "./index";
import type { InsightsEventBody } from "./sender";

const DAY_MS = 86_400_000;
const MORNING = Date.UTC(2026, 8, 30, 9);

/** The device a test's launches share, and what the server received. */
let storage: ClientPluginTestStorage;
let sent: ClientPluginTestRequest[] = [];
let responses: (number | (() => Response))[] = [];
let appVersion: string | null = "1.0.0";
let installId: () => string = () => "install-id";
let isDebugBuild = false;

const sentEvents = () =>
  sent.map((request) => request.json<InsightsEventBody>());
const sentTypes = () => sentEvents().map(({ type }) => type);

/** A server without Insights mounts no `/events`. */
const disabledResponse = () => new Response(null, { status: 404 });

/** Starts a JavaScript runtime with the plugin on the test's device. */
const launch = async (options: InsightsOptions = {}) => {
  const runtime = setupClientPlugin(insights(options), {
    baseURL: "https://updates.example.com/hot-updater",
    requestHeaders: { "x-api-key": "client-key" },
    respond: (request) => {
      sent.push(request);
      const next = responses.shift() ?? 204;
      return typeof next === "number"
        ? new Response(null, { status: next })
        : next();
    },
    storage,
    installId,
    appVersion,
    sdkVersion: "test-sdk-version",
    isDebugBuild,
    bundleId: "bundle-a",
    channel: "production",
    cohort: "123",
    fingerprintHash: "fingerprint-hash",
  });
  return {
    // What `hotUpdater.insights` is on the instance init returns.
    insights: runtime.api,
    runtime,
    appReady: runtime.hooks.onAppReady,
    updateCheck: runtime.hooks.onUpdateCheck,
    downloaded: runtime.hooks.onBundleDownloaded,
    updateError: runtime.hooks.onUpdateError,
  };
};

type UnchangedLaunch = Extract<AppReadyResult, { status: "UNCHANGED" }>;
type TransitionLaunch = Exclude<AppReadyResult, UnchangedLaunch>;

const unchangedLaunch = (
  overrides: Partial<UnchangedLaunch> = {},
): UnchangedLaunch => ({
  status: "UNCHANGED",
  channel: "production",
  bundleId: "bundle-a",
  releaseId: "release-a",
  ...overrides,
});

const appliedLaunch: TransitionLaunch = {
  status: "UPDATE_APPLIED",
  channel: "production",
  fromBundleId: "bundle-a",
  fromReleaseId: "release-a",
  toBundleId: "bundle-b",
  toReleaseId: "release-b",
  updateStrategy: "appVersion",
};

const download: BundleDownloadedInfo = {
  channel: "production",
  fromBundleId: "bundle-a",
  fromReleaseId: "release-a",
  toBundleId: "bundle-b",
  toReleaseId: "release-b",
  updateStrategy: "appVersion",
  delivery: "manifest",
  patchFallback: false,
};

const downloadFailure = (
  overrides: Partial<UpdateError> = {},
): UpdateError => ({
  stage: "download",
  reason: "hash_mismatch",
  targetBundleId: "bundle-b",
  targetReleaseId: "release-b",
  channel: "production",
  bundleId: "bundle-a",
  releaseId: "release-a",
  updateStrategy: "fingerprint",
  cause: new Error("hash mismatch"),
  ...overrides,
});

const flush = () => vi.runAllTimersAsync();

describe("insights() client plugin", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: MORNING });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    storage = createTestStorage();
    sent = [];
    responses = [];
    appVersion = "1.0.0";
    installId = () => "install-id";
    isDebugBuild = false;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("adds no requests for repeated checks and carries the latest response on the next daily launch", async () => {
    const app = await launch();
    app.appReady(unchangedLaunch());
    await flush();
    for (let index = 0; index < 10; index++) {
      app.runtime.hooks.onHttpResponse({
        resource: "catalog",
        path: "/catalog",
        status: index === 0 ? 200 : 304,
        body: index === 0 ? '{"releases":[]}' : "",
        bodyTruncated: false,
      });
      app.updateCheck({
        status: "UNCHANGED",
        channel: "production",
        bundleId: "bundle-a",
        releaseId: "release-a",
        previousReleaseId: "release-a",
      });
      await flush();
    }
    (await launch()).appReady(unchangedLaunch());
    await flush();
    expect(sentTypes()).toEqual(["UNCHANGED"]);
    vi.setSystemTime(MORNING + DAY_MS);
    (await launch()).appReady(unchangedLaunch());
    await flush();
    expect(sentTypes()).toEqual(["UNCHANGED", "UNCHANGED"]);
    expect(sentEvents()[1]?.metadata?.httpResponse).toEqual({
      resource: "catalog",
      path: "/catalog",
      status: 304,
      body: "",
      bodyTruncated: false,
      receivedAtMs: MORNING,
    });
  });

  it("attaches the failing server response without changing duplicate failure reporting", async () => {
    const app = await launch();
    for (const body of [
      '{"requestId":"first","error":"Unavailable"}',
      '{"requestId":"second","error":"Unavailable"}',
    ]) {
      app.runtime.hooks.onHttpResponse({
        resource: "catalog",
        path: "/catalog",
        status: 503,
        body,
        bodyTruncated: false,
      });
      app.updateError(
        downloadFailure({
          stage: "check",
          reason: "http",
          resource: "catalog",
          httpStatus: 503,
          cause: new Error("Request failed with HTTP 503"),
        }),
      );
      await flush();
    }
    expect(sentTypes()).toEqual(["UPDATE_FAILED"]);
    expect(sentEvents()[0]?.metadata?.httpResponse).toMatchObject({
      status: 503,
      body: '{"requestId":"first","error":"Unavailable"}',
      receivedAtMs: MORNING,
    });
  });

  it.each(["한😀".repeat(2_000), "", null])(
    "bounds a stored body and sends it only with the existing download report",
    async (body) => {
      const app = await launch();
      app.runtime.hooks.onHttpResponse({
        resource: "artifact",
        path: "/artifacts/v1/target/from/current",
        status: 200,
        body,
        bodyTruncated: false,
      });
      await flush();
      expect(sent).toHaveLength(0);
      app.downloaded(download);
      await flush();
      expect(sentTypes()).toEqual(["UPDATE_DOWNLOADED"]);
      const response = sentEvents()[0]?.metadata?.httpResponse;
      expect(
        Buffer.byteLength(JSON.stringify(response?.body)),
      ).toBeLessThanOrEqual(4_096);
      expect(response?.bodyTruncated).toBe(Boolean(body));
      if (body) expect(response?.body?.isWellFormed()).toBe(true);
      else expect(response?.body).toBe(body);
    },
  );

  it("does not attach a response from another app version or channel", async () => {
    const app = await launch();
    app.runtime.hooks.onHttpResponse({
      resource: "catalog",
      path: "/catalog",
      status: 200,
      body: "{}",
      bodyTruncated: false,
    });
    app.appReady(unchangedLaunch({ channel: "staging" }));
    await flush();
    appVersion = "2.0.0";
    (await launch()).appReady(unchangedLaunch());
    await flush();
    expect(
      sentEvents().every((event) => event.metadata?.httpResponse === undefined),
    ).toBe(true);
  });

  it("posts a launch as UNCHANGED with the app's identity", async () => {
    const app = await launch();

    app.appReady(unchangedLaunch());
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      url: "https://updates.example.com/hot-updater/events",
      headers: { "x-api-key": "client-key" },
    });
    const [event] = sentEvents();
    expect(isUUIDv7(event?.eventId)).toBe(true);
    expect(event).toEqual({
      appVersion: "1.0.0",
      channel: "production",
      cohort: "123",
      eventId: event?.eventId,
      fingerprintHash: "fingerprint-hash",
      fromBundleId: null,
      fromReleaseId: null,
      installId: "install-id",
      minBundleId: "00000000-0000-0000-0000-000000000000",
      platform: "ios",
      sdkVersion: "test-sdk-version",
      toBundleId: "bundle-a",
      toReleaseId: "release-a",
      type: "UNCHANGED",
      updateStrategy: null,
    });
  });

  describe("daily launch reports", () => {
    it("sends UNCHANGED at most once per UTC day across launches", async () => {
      (await launch()).appReady(unchangedLaunch());
      await flush();

      vi.setSystemTime(Date.UTC(2026, 8, 30, 23, 59));
      (await launch()).appReady(unchangedLaunch());
      await flush();
      expect(sent).toHaveLength(1);

      vi.setSystemTime(Date.UTC(2026, 9, 1, 0, 1));
      (await launch()).appReady(unchangedLaunch());
      await flush();
      expect(sentTypes()).toEqual(["UNCHANGED", "UNCHANGED"]);
    });

    it.each([
      { label: "channel", change: { channel: "beta" } },
      { label: "bundle", change: { bundleId: "bundle-c" } },
      { label: "Release", change: { releaseId: "release-c" } },
    ])(
      "reports a launch again the same day when its $label changes",
      async ({ change }) => {
        (await launch()).appReady(unchangedLaunch());
        await flush();

        (await launch()).appReady(unchangedLaunch(change));
        await flush();

        expect(sentTypes()).toEqual(["UNCHANGED", "UNCHANGED"]);
      },
    );

    it("reports a launch again the same day when the app version or user changes", async () => {
      (await launch()).appReady(unchangedLaunch());
      await flush();

      appVersion = "1.0.1";
      (await launch()).appReady(unchangedLaunch());
      await flush();

      const app = await launch();
      app.insights.setUser({ userId: "user-1" });
      app.appReady(unchangedLaunch());
      await flush();

      expect(
        sentEvents().map(({ appVersion, userId }) => [appVersion, userId]),
      ).toEqual([
        ["1.0.0", undefined],
        ["1.0.1", undefined],
        ["1.0.1", "user-1"],
      ]);
    });

    it("counts a delivered apply as the day's report of its bundle", async () => {
      (await launch()).appReady(appliedLaunch);
      await flush();

      (await launch()).appReady(
        unchangedLaunch({ bundleId: "bundle-b", releaseId: "release-b" }),
      );
      await flush();

      expect(sentTypes()).toEqual(["UPDATE_APPLIED"]);
    });

    it("reports the next launch after a delivered download or failure", async () => {
      const first = await launch();
      first.appReady(unchangedLaunch());
      await flush();
      first.downloaded(download);
      await flush();

      const second = await launch();
      second.appReady(unchangedLaunch());
      await flush();
      second.updateError(downloadFailure());
      await flush();

      (await launch()).appReady(unchangedLaunch());
      await flush();

      expect(sentTypes()).toEqual([
        "UNCHANGED",
        "UPDATE_DOWNLOADED",
        "UNCHANGED",
        "UPDATE_FAILED",
        "UNCHANGED",
      ]);
    });

    it("reports the launch again when the server did not store it", async () => {
      responses = [400];
      vi.spyOn(console, "warn").mockImplementation(() => {});
      (await launch()).appReady(unchangedLaunch());
      await flush();

      (await launch()).appReady(unchangedLaunch());
      await flush();

      expect(sentTypes()).toEqual(["UNCHANGED", "UNCHANGED"]);
    });

    it("always sends downloads, applies, and recoveries", async () => {
      const first = await launch();
      first.appReady(unchangedLaunch());
      first.downloaded(download);
      await flush();

      (await launch()).appReady(appliedLaunch);
      (await launch()).appReady({
        ...appliedLaunch,
        status: "RECOVERED",
        fromBundleId: "bundle-b",
        toBundleId: "bundle-a",
      });
      await flush();

      expect(sentTypes()).toEqual([
        "UNCHANGED",
        "UPDATE_DOWNLOADED",
        "UPDATE_APPLIED",
        "RECOVERED",
      ]);
    });

    it("sends one report when the launch and a no-update check both report", async () => {
      const app = await launch();

      app.appReady(unchangedLaunch());
      app.updateCheck({
        status: "UNCHANGED",
        channel: "production",
        bundleId: "bundle-a",
        releaseId: "release-a",
        previousReleaseId: "release-a",
      });
      await flush();

      expect(sentTypes()).toEqual(["UNCHANGED"]);
    });

    it("reports a same-bundle Release adoption with the Release it replaced", async () => {
      const app = await launch();
      app.appReady(unchangedLaunch());
      await flush();

      app.updateCheck({
        status: "UNCHANGED",
        channel: "production",
        bundleId: "bundle-a",
        releaseId: "release-a2",
        previousReleaseId: "release-a",
      });
      await flush();

      expect(sentEvents()[1]).toMatchObject({
        fromReleaseId: "release-a",
        toBundleId: "bundle-a",
        toReleaseId: "release-a2",
        type: "UNCHANGED",
      });
    });

    it("sends no launch report after a download in the same runtime", async () => {
      const app = await launch();

      app.downloaded(download);
      app.downloaded(download);
      app.updateCheck({
        status: "UNCHANGED",
        channel: "production",
        bundleId: "bundle-b",
        releaseId: "release-b",
        previousReleaseId: "release-b",
      });
      await flush();

      expect(sentTypes()).toEqual(["UPDATE_DOWNLOADED"]);
    });
  });

  describe("when the server runs without Insights", () => {
    it("sends nothing more in this runtime after a 404", async () => {
      responses = [disabledResponse];
      const app = await launch();

      app.appReady(unchangedLaunch());
      await flush();
      app.downloaded(download);
      await flush();
      vi.setSystemTime(MORNING + 2 * DAY_MS);
      app.updateError(downloadFailure());
      await flush();

      expect(sentTypes()).toEqual(["UNCHANGED"]);
    });

    it("pauses later launches for 24 hours, then probes again", async () => {
      responses = [disabledResponse];
      (await launch()).appReady(unchangedLaunch());
      await flush();

      vi.setSystemTime(MORNING + DAY_MS - 1);
      (await launch()).appReady(appliedLaunch);
      await flush();
      expect(sent).toHaveLength(1);

      vi.setSystemTime(MORNING + DAY_MS);
      (await launch()).appReady(appliedLaunch);
      await flush();
      expect(sentTypes()).toEqual(["UNCHANGED", "UPDATE_APPLIED"]);

      // The probe was stored, so Insights is on again.
      (await launch()).appReady({ ...appliedLaunch, toBundleId: "bundle-c" });
      await flush();
      expect(sentTypes()).toEqual([
        "UNCHANGED",
        "UPDATE_APPLIED",
        "UPDATE_APPLIED",
      ]);
    });

    it("ends a pause that starts after now, from a clock that went back", async () => {
      storage.set("insights", "pausedAt", String(MORNING + 60 * 60 * 1000));

      (await launch()).appReady(unchangedLaunch());
      await flush();

      expect(sentTypes()).toEqual(["UNCHANGED"]);
    });
  });

  describe("update failures", () => {
    it("reports a failure once per UTC day per stage, reason, and target", async () => {
      const app = await launch();

      app.updateError(downloadFailure({ httpStatus: undefined }));
      app.updateError(downloadFailure());
      await flush();
      (await launch()).updateError(downloadFailure());
      await flush();

      expect(sent).toHaveLength(1);
      const [event] = sentEvents();
      expect(event).toMatchObject({
        fromBundleId: "bundle-a",
        fromReleaseId: "release-a",
        metadata: { failure: { reason: "hash_mismatch", stage: "download" } },
        toBundleId: "bundle-b",
        toReleaseId: "release-b",
        type: "UPDATE_FAILED",
        updateStrategy: "fingerprint",
      });
      expect(event?.metadata?.failure).toEqual({
        reason: "hash_mismatch",
        stage: "download",
        errorMessage: "hash mismatch",
        errorStack: expect.stringContaining("Error: hash mismatch"),
      });
      // A UUIDv7 led by the UTC day, the same on every device for one failure.
      expect(isUUIDv7(event?.eventId)).toBe(true);
      expect(parseInt(event!.eventId.replace(/-/g, "").slice(0, 12), 16)).toBe(
        Date.UTC(2026, 8, 30),
      );

      (await launch()).updateError(downloadFailure({ reason: "signature" }));
      vi.setSystemTime(MORNING + DAY_MS);
      (await launch()).updateError(downloadFailure());
      await flush();

      const ids = sentEvents().map(({ eventId }) => eventId);
      expect(
        sentEvents().map(({ metadata }) => metadata?.failure?.reason),
      ).toEqual(["hash_mismatch", "signature", "hash_mismatch"]);
      expect(new Set(ids).size).toBe(3);
    });

    it("gives a failure that was not delivered the same id when it happens again", async () => {
      responses = [500, 500, 500];
      vi.spyOn(console, "warn").mockImplementation(() => {});
      (await launch()).updateError(downloadFailure());
      await flush();

      (await launch()).updateError(downloadFailure());
      await flush();

      const ids = sentEvents().map(({ eventId }) => eventId);
      expect(ids).toHaveLength(4);
      expect(new Set(ids).size).toBe(1);
    });

    it("skips check failures while offline and reports the others against the running bundle", async () => {
      const app = await launch();
      const checkFailure = {
        stage: "check",
        channel: "production",
        bundleId: "bundle-a",
        releaseId: "release-a",
        updateStrategy: "appVersion",
        cause: new Error("check failed"),
      } as const;

      app.updateError({ ...checkFailure, reason: "network" });
      app.updateError({ ...checkFailure, reason: "http", httpStatus: 503 });
      await flush();

      expect(sentEvents()).toEqual([
        expect.objectContaining({
          fromBundleId: "bundle-a",
          metadata: {
            failure: {
              httpStatus: 503,
              reason: "http",
              stage: "check",
              errorMessage: "check failed",
              errorStack: expect.stringContaining("Error: check failed"),
            },
          },
          toBundleId: "bundle-a",
          toReleaseId: null,
          type: "UPDATE_FAILED",
        }),
      ]);
    });

    it("reports distinct original check errors without requiring a known category", async () => {
      const app = await launch();
      for (const message of [
        "Release transition rejected: UNSOLICITED_SCOPE",
        "Unexpected native state: 42",
        "Release transition rejected: UNSOLICITED_SCOPE",
      ]) {
        const cause = new Error(message);
        cause.stack = `Error: ${message}\n    at checkForUpdate (app.js:12:3)`;
        app.updateError({
          ...downloadFailure(),
          stage: "check",
          reason: "unknown",
          resource: "catalog",
          targetBundleId: undefined,
          targetReleaseId: undefined,
          cause,
        });
        await flush();
      }
      expect(sentEvents().map((event) => event.metadata?.failure)).toEqual([
        {
          stage: "check",
          reason: "unknown",
          resource: "catalog",
          errorMessage: "Release transition rejected: UNSOLICITED_SCOPE",
          errorStack:
            "Error: Release transition rejected: UNSOLICITED_SCOPE\n    at checkForUpdate (app.js:12:3)",
        },
        {
          stage: "check",
          reason: "unknown",
          resource: "catalog",
          errorMessage: "Unexpected native state: 42",
          errorStack:
            "Error: Unexpected native state: 42\n    at checkForUpdate (app.js:12:3)",
        },
      ]);
      expect(new Set(sentEvents().map((event) => event.eventId)).size).toBe(2);
    });

    it("drops a failure an older server refuses, without retrying, warning, or pausing", async () => {
      responses = [400];
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const app = await launch();

      app.updateError(downloadFailure());
      await flush();
      app.updateError(downloadFailure());
      app.appReady(unchangedLaunch());
      await flush();

      expect(sentTypes()).toEqual(["UPDATE_FAILED", "UNCHANGED"]);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("event details", () => {
    it("says how a download arrived, and when a patch fell back", async () => {
      const app = await launch();

      app.downloaded({ ...download, delivery: "patch", patchFallback: false });
      app.downloaded({
        ...download,
        toBundleId: "bundle-c",
        delivery: "archive",
        patchFallback: true,
      });
      await flush();

      expect(sentEvents().map(({ metadata }) => metadata)).toEqual([
        { delivery: "patch" },
        { delivery: "archive", patchFallback: true },
      ]);
    });

    it("sends a recovery and an apply without metadata", async () => {
      const app = await launch();

      app.appReady({
        ...appliedLaunch,
        status: "RECOVERED",
        fromBundleId: "bundle-b",
        toBundleId: "bundle-a",
      });
      await flush();
      (await launch()).appReady({ ...appliedLaunch, toBundleId: "bundle-c" });
      await flush();

      expect(
        sentEvents().map(({ type, metadata }) => [type, metadata]),
      ).toEqual([
        ["RECOVERED", undefined],
        ["UPDATE_APPLIED", undefined],
      ]);
    });

    it("sends every failure detail it has", async () => {
      const app = await launch();

      app.updateError(
        downloadFailure({
          reason: "http",
          resource: "archive",
          httpStatus: 403,
          originCode: "ExpiredToken",
        }),
      );
      app.updateError(
        downloadFailure({
          reason: "network",
          resource: "file",
          transport: "tls",
        }),
      );
      await flush();

      expect(sentEvents().map(({ metadata }) => metadata?.failure)).toEqual([
        {
          stage: "download",
          reason: "http",
          resource: "archive",
          httpStatus: 403,
          originCode: "ExpiredToken",
          errorMessage: "hash mismatch",
          errorStack: expect.stringContaining("Error: hash mismatch"),
        },
        {
          stage: "download",
          reason: "network",
          resource: "file",
          transport: "tls",
          errorMessage: "hash mismatch",
          errorStack: expect.stringContaining("Error: hash mismatch"),
        },
      ]);
    });
  });

  describe("a success for a failed target", () => {
    it("drops a queued failure for the target a download then staged", async () => {
      responses = [503];
      const app = await launch();

      app.appReady(unchangedLaunch());
      app.updateError(downloadFailure());
      app.downloaded(download);
      await flush();

      expect(sentTypes()).toEqual([
        "UNCHANGED",
        "UNCHANGED",
        "UPDATE_DOWNLOADED",
      ]);
    });

    it("drops a failure waiting out a backoff once its target applies", async () => {
      responses = [503];
      const app = await launch();

      app.updateError(downloadFailure());
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      app.appReady(appliedLaunch);
      await flush();

      expect(sentTypes()).toEqual(["UPDATE_FAILED", "UPDATE_APPLIED"]);
    });

    it("keeps a failure for another target", async () => {
      const app = await launch();

      app.updateError(downloadFailure({ targetBundleId: "bundle-c" }));
      app.downloaded(download);
      await flush();

      expect(sentTypes()).toEqual(["UPDATE_FAILED", "UPDATE_DOWNLOADED"]);
    });
  });

  describe("user", () => {
    it("attaches the user and keeps it across launches", async () => {
      const first = await launch();
      first.insights.setUser({ userId: 42 });
      first.appReady(unchangedLaunch());
      await flush();

      (await launch()).appReady(appliedLaunch);
      await flush();

      const app = await launch();
      app.insights.setUser(null);
      app.appReady(unchangedLaunch({ bundleId: "bundle-c" }));
      await flush();

      expect(sentEvents().map(({ userId }) => userId)).toEqual([
        "42",
        "42",
        undefined,
      ]);
      expect(sentEvents().every((event) => !("username" in event))).toBe(true);
    });

    it("takes only a user id", () => {
      const user: InsightsUser = { userId: "user-1" };
      // @ts-expect-error Insights keeps no username.
      const withName: InsightsUser = { userId: "user-1", username: "Alex" };
      expect([user, withName]).toHaveLength(2);
    });
  });

  it.each([
    { debug: undefined, sends: false },
    { debug: true, sends: true },
  ])(
    "sends from a debug build only with debug: true ($debug)",
    async ({ debug, sends }) => {
      isDebugBuild = true;
      const app = await launch(debug === undefined ? {} : { debug });

      // App code calls setUser in every build.
      app.insights.setUser({ userId: "user-1" });
      app.appReady(unchangedLaunch());
      await flush();

      expect(sent).toHaveLength(sends ? 1 : 0);
    },
  );

  it("reports a failed install id read as a plugin error, not an update failure", async () => {
    installId = () => {
      throw new Error("native install id unavailable");
    };
    const app = await launch();

    app.appReady(unchangedLaunch());
    await flush();

    expect(sent).toEqual([]);
    expect(
      app.runtime.errors.map((error) => [
        error.message,
        (error.cause as Error).message,
      ]),
    ).toEqual([
      [
        '[HotUpdater] Plugin "insights" failed in onAppReady',
        "native install id unavailable",
      ],
    ]);
  });

  it("skips a report without a native app version", async () => {
    appVersion = null;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = await launch();

    app.appReady(unchangedLaunch());
    await flush();

    expect(sent).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "[HotUpdater] Insights needs the native app version; the UNCHANGED event was not sent.",
    );
  });
});
