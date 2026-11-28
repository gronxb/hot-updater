import { stripVTControlCharacters } from "node:util";

import { loadConfig } from "@hot-updater/cli-tools";
import {
  type AnyHotUpdaterPlugin,
  type Bundle,
  createMemoryAdapter,
  type EngineDatabase,
  meterReads,
  type RemoteDatabase,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { apiKeys, insights } from "@hot-updater/server/plugins";
import { createReleaseCatalogTestStorage } from "@hot-updater/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleInsightsEvents,
  handleInsightsFailures,
  handleInsightsInstallations,
  handleInsightsOverview,
} from "./insights";

const { log, printBanner } = vi.hoisted(() => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    warn: vi.fn(),
  },
  printBanner: vi.fn(),
}));

// The server assembles for real: only the config is mocked.
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  loadConfig: vi.fn(),
  p: { confirm: vi.fn(), isCancel: vi.fn(() => false), log },
}));

vi.mock("@/utils/printBanner", () => ({ printBanner }));

vi.mock("./utils/load-hot-updater", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils/load-hot-updater")>()),
  findDefaultConfigPaths: vi.fn(() => []),
  loadHotUpdater: vi.fn(),
}));

const BUNDLE_ID = "00000000-0000-7000-8000-000000000001";

// The seed's clock, inside an hour and a UTC day. The app reports downloads
// and a failure at REPORTED_AT_MS, launches a second later, and the CLI reads a
// minute after that. A list's default cutoff is the read's Date.now() and lists
// cover [since, cutoff), so on a real clock a read in the millisecond of the
// launch left the launch out; and a launch in the millisecond of its download
// was ordered against it by event ID alone.
const REPORTED_AT_MS = Date.UTC(2026, 10, 16, 12, 30);
const LAUNCHED_AT_MS = REPORTED_AT_MS + 1_000;
const READ_AT_MS = REPORTED_AT_MS + 60_000;

const createDatabase = (): EngineDatabase & {
  dispose: ReturnType<typeof vi.fn>;
} => ({
  name: "memory",
  adapter: createMemoryAdapter(),
  dispose: vi.fn(async () => {}),
});

/** A server with insights() over `db`, as the app reports to it. */
const serverOver = (db: EngineDatabase) =>
  createHotUpdater({
    database: { name: "memory", adapter: db.adapter },
    storage: createReleaseCatalogTestStorage(),
    plugins: [insights()],
    clientAccess: "public",
  });

const artifact: Bundle = {
  assetBaseStorageUri: "storage://assets",
  id: BUNDLE_ID,
  platform: "ios",
  gitCommitHash: "1234567890abcdef",
  manifestFileHash: "manifest-hash",
  manifestStorageUri: `storage://artifacts/${BUNDLE_ID}/manifest.json`,
};

/** Deploys the bundle to production and reports a download, a launch, and a failed update of it. */
const seed = async (db: EngineDatabase) => {
  vi.setSystemTime(REPORTED_AT_MS);
  const server = serverOver(db);
  const [deployed] = await server.core.deploy([
    {
      bundle: artifact,
      release: {
        channel: "production",
        enabled: true,
        fingerprintHash: null,
        message: null,
        shouldForceUpdate: false,
        targetAppVersion: "1.0.x",
      },
    },
  ]);
  const release = deployed!.release!;
  const report = (body: Record<string, unknown>) =>
    server.handlers.client(
      new Request("https://updates.example.com/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appVersion: "1.0.0",
          channel: "production",
          cohort: "42",
          fingerprintHash: null,
          fromBundleId: "00000000-0000-0000-0000-000000000000",
          fromReleaseId: null,
          platform: "ios",
          toBundleId: BUNDLE_ID,
          toReleaseId: release.id,
          updateStrategy: "appVersion",
          userId: "user-1",
          ...body,
        }),
      }),
    );
  for (const response of await Promise.all([
    report({ installId: "install-1", type: "UPDATE_DOWNLOADED" }),
    report({ installId: "install-2", type: "UPDATE_DOWNLOADED" }),
    report({
      installId: "install-3",
      type: "UPDATE_FAILED",
      metadata: { failure: { stage: "download", reason: "network" } },
    }),
  ])) {
    expect(response.status).toBe(204);
  }
  vi.setSystemTime(LAUNCHED_AT_MS);
  expect(
    (await report({ installId: "install-1", type: "UPDATE_APPLIED" })).status,
  ).toBe(204);
  vi.setSystemTime(READ_AT_MS);
  return release;
};

let database: ReturnType<typeof createDatabase>;

const configure = (config: {
  readonly database?: EngineDatabase | RemoteDatabase;
  readonly plugins?: readonly AnyHotUpdaterPlugin[];
}) => {
  vi.mocked(loadConfig).mockResolvedValue({
    plugins: [],
    storage: createReleaseCatalogTestStorage(),
    ...config,
  } as never);
};

const messages = () =>
  log.message.mock.calls
    .map(([text]) => stripVTControlCharacters(String(text)))
    .join("\n");

const jsonOutput = () =>
  JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as Record<
    string,
    unknown
  >;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.spyOn(console, "log").mockImplementation(() => {});
  database = createDatabase();
  configure({ database, plugins: [insights(), apiKeys()] });
});

afterEach(() => {
  process.exitCode = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("hot-updater insights over hot-updater.config.ts", () => {
  it("counts a bundle's reports by the ID shown in the console, in the console's words", async () => {
    const release = await seed(database);

    await handleInsightsOverview({ bundle: release.id, window: "7d" });

    const printed = messages();
    expect(printed).toContain("Insights · iOS · production · last 7d");
    expect(printed).toMatch(
      /Reporting installations │ On the bundle │ Downloaded │ Launched │ Crashed │ Failed/u,
    );
    // install-2 downloaded the bundle and has not launched it yet.
    expect(printed).toMatch(/│ 2\s+│ 1\s+│ 2\s+│ 1\s+│ 0\s+│ 1\s+│/u);
    expect(printBanner).toHaveBeenCalledOnce();
    expect(database.dispose).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();

    // Its JSON calls the release ID the bundle ID, as --bundle takes it.
    await handleInsightsOverview({ bundle: release.id, json: true });
    expect(jsonOutput()).toMatchObject({
      bundle: { reportingInstallations: { count: 1 } },
    });
    const { bundle } = jsonOutput() as { bundle: Record<string, unknown> };
    expect(bundle["bundleId"]).toBe(release.id);
    expect(bundle).not.toHaveProperty("releaseId");

    await handleInsightsOverview({
      json: true,
      platform: "ios",
      channel: "production",
    });
    expect(jsonOutput()).toMatchObject({
      platform: "ios",
      channel: "production",
      window: "24h",
      // A failed update leaves an installation's latest report as it was.
      reportingInstallations: { count: 2 },
    });
  });

  it("--bundle reads the bundle's channel, not every channel", async () => {
    const readsWith = async (channels: number) => {
      const metered = meterReads({
        name: "memory",
        adapter: createMemoryAdapter(),
      });
      const release = await seed(metered);
      for (let n = 1; n <= channels; n += 1) {
        await serverOver(metered).core.ensureChannel(`pr-${n}`);
      }
      configure({ database: metered, plugins: [insights()] });
      const { adapter } = await metered.measureReads(() =>
        handleInsightsOverview({ bundle: release.id, json: true }),
      );
      expect(jsonOutput()).toMatchObject({ channel: "production" });
      return adapter.rows + adapter.keys;
    };

    expect(await readsWith(1_000)).toBe(await readsWith(10));
  }, 60_000);

  it("shows a bundle's update failures, their rate, and their breakdown", async () => {
    const release = await seed(database);

    await handleInsightsFailures({ bundle: release.id });

    const printed = messages();
    expect(printed).toContain(
      `Update failures of ${release.id} · iOS · production · last 24h`,
    );
    expect(printed).toMatch(/│ 33\.33%\s+│ 1 of 3\s+│ 1\s+│ 2\s+│/u);
    expect(printed).toMatch(/download\s*│ network\s*│ 1/u);

    await handleInsightsFailures({
      json: true,
      platform: "ios",
      channel: "production",
      window: "7d",
    });
    expect(jsonOutput()).toMatchObject({
      platform: "ios",
      channel: "production",
      failedUpdates: 1,
      downloads: 2,
      endMs: expect.any(Number),
    });
  });

  it("marks failure counts as lower bounds when an hour held more failures than are read", async () => {
    await seed(database);
    vi.setSystemTime(REPORTED_AT_MS);
    const server = serverOver(database);
    // 30 failed checks of distinct HTTP statuses in the seed's hour.
    for (let n = 0; n < 30; n += 1) {
      const response = await server.handlers.client(
        new Request("https://updates.example.com/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            appVersion: "1.0.0",
            channel: "production",
            cohort: "42",
            fingerprintHash: null,
            fromBundleId: BUNDLE_ID,
            fromReleaseId: null,
            platform: "ios",
            toBundleId: BUNDLE_ID,
            toReleaseId: null,
            updateStrategy: "appVersion",
            userId: "user-1",
            installId: `flood-${n}`,
            type: "UPDATE_FAILED",
            metadata: {
              failure: { stage: "check", reason: "http", httpStatus: 400 + n },
            },
          }),
        }),
      );
      expect(response.status).toBe(204);
    }
    vi.setSystemTime(READ_AT_MS);

    await handleInsightsFailures({ platform: "ios", channel: "production" });

    const printed = messages();
    expect(printed).toMatch(/│ ≥33\.33%\s+│ ≥1 of ≥3\s+│/u);
    expect(printed).toContain(
      "Partial: 1 hour held more failure kinds than are read, so failures are at least the counts shown.",
    );
    expect(printed).not.toContain("past retention");
  });

  it("lists a bundle's reports of one outcome, and an installation's", async () => {
    const release = await seed(database);

    await handleInsightsEvents({
      bundle: release.id,
      outcome: "launched",
      json: true,
    });
    expect(jsonOutput()).toMatchObject({
      data: [{ type: "UPDATE_APPLIED", installId: "install-1" }],
      nextCursor: null,
    });

    expect(jsonOutput()).toMatchObject({
      data: [{ toReleaseId: release.id, toBundleId: BUNDLE_ID }],
    });

    await handleInsightsEvents({ install: "install-1" });
    const printed = messages();
    expect(printed).toMatch(/Launched\s*│ install-1/u);
    expect(printed).toMatch(/Downloaded\s*│ install-1/u);
    expect(printed).not.toContain("install-2");
    // The bundle column names the release, the ID --bundle takes back, and
    // the built-in bundle it came from, which has none.
    expect(printed).toContain(
      `00000000-0000-0000-0000-000000000000 → ${release.id}`,
    );
    expect(printed).not.toContain(BUNDLE_ID);

    await handleInsightsEvents({ bundle: release.id });
    expect(log.error).toHaveBeenCalledWith(
      "Pass --outcome with --bundle: downloaded, launched, crashed, failed.",
    );
    expect(process.exitCode).toBe(1);
  });

  it("pages events with the cursor it prints", async () => {
    await seed(database);

    await handleInsightsEvents({ limit: 3 });
    const more = /--cursor (\S+)/u.exec(messages())?.[1];
    expect(more).toBeDefined();

    log.message.mockClear();
    await handleInsightsEvents({ limit: 3, cursor: more, json: true });
    expect(jsonOutput()).toMatchObject({ data: [{}], nextCursor: null });
  });

  it("finds installations by install ID or by user ID", async () => {
    const release = await seed(database);

    await handleInsightsInstallations("install-1");
    const printed = messages();
    expect(printed).toContain("install-1");
    expect(printed).toMatch(/^Latest {2,}Launched/mu);
    expect(printed).toMatch(new RegExp(`^Bundle {2,}${release.id}`, "mu"));
    expect(printed).not.toContain(BUNDLE_ID);

    // install-2 downloaded the release and has not launched it yet.
    log.message.mockClear();
    await handleInsightsInstallations("install-2");
    expect(messages()).toMatch(new RegExp(`^Pending {2,}${release.id}`, "mu"));

    await handleInsightsInstallations("user-1", { json: true });
    expect(
      (jsonOutput()["data"] as { installId: string }[])
        .map(({ installId }) => installId)
        .sort(),
    ).toEqual(["install-1", "install-2"]);
  });

  it("refuses a bundle with a platform or channel, and one it does not have", async () => {
    await handleInsightsOverview({
      bundle: BUNDLE_ID,
      platform: "ios",
      channel: "production",
    });
    expect(log.error).toHaveBeenCalledWith(
      "Pass --bundle, or --platform and --channel, not both: a bundle has its own platform and channel.",
    );

    await handleInsightsFailures({ bundle: "missing" });
    expect(log.error).toHaveBeenCalledWith('Bundle "missing" was not found.');

    await handleInsightsOverview({ platform: "ios" });
    expect(log.error).toHaveBeenCalledWith(
      "Pass --platform and --channel, or --bundle with a bundle's ID.",
    );
    expect(process.exitCode).toBe(1);
    expect(database.dispose).toHaveBeenCalledTimes(3);
  });

  it("needs insights() in the config's plugins, the plugin the server runs", async () => {
    configure({ database, plugins: [apiKeys()] });

    await handleInsightsEvents();

    expect(log.error).toHaveBeenCalledWith(
      'hot-updater.config.ts lists no insights() in plugins. Add insights() to plugins, the same plugin your server runs (import { insights } from "hot-updater/plugins").',
    );
    expect(process.exitCode).toBe(1);
  });
});

describe("hot-updater insights over standaloneRepository", () => {
  /** A standaloneRepository whose admin API is the server's real admin handler. */
  const remoteOf = (server: {
    readonly core: RemoteDatabase["core"];
    readonly handlers: {
      admin(request: Request): Promise<Response>;
    };
  }) =>
    ({
      name: "standalone",
      core: server.core,
      fetchAdmin: vi.fn((adminPath: string, init?: RequestInit) =>
        server.handlers.admin(
          new Request(`https://updates.example.com${adminPath}`, init),
        ),
      ),
      dispose: vi.fn(async () => {}),
    }) satisfies RemoteDatabase;

  it("reads through the server's admin routes, resolving a bundle through its core", async () => {
    const serverDatabase = createDatabase();
    const release = await seed(serverDatabase);
    const remote = remoteOf(serverOver(serverDatabase));
    configure({ database: remote, plugins: [insights()] });

    await handleInsightsFailures({ bundle: release.id, json: true });

    expect(jsonOutput()).toMatchObject({
      releaseId: release.id,
      failedUpdates: 1,
      downloads: 2,
    });
    expect(remote.fetchAdmin).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\/failures\?platform=ios&channel=production&releaseId=/u,
      ),
    );
    expect(remote.dispose).toHaveBeenCalledOnce();
  });

  it("says when the server runs without insights()", async () => {
    const remote = remoteOf(
      createHotUpdater({
        database: createDatabase(),
        storage: createReleaseCatalogTestStorage(),
        plugins: [],
        clientAccess: "public",
      }),
    );
    configure({ database: remote, plugins: [insights()] });

    await handleInsightsEvents();

    expect(log.error).toHaveBeenCalledWith(
      "The server runs without insights(): its admin API serves no Insights routes. Add insights() to the plugins of createHotUpdater on the server, and deploy it.",
    );
    expect(process.exitCode).toBe(1);
  });
});
