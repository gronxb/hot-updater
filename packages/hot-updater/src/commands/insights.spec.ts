import { stripVTControlCharacters } from "node:util";

import { loadConfig } from "@hot-updater/cli-tools";
import {
  type AnyHotUpdaterPlugin,
  type Bundle,
  createMemoryAdapter,
  type EngineDatabase,
  type RemoteDatabase,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { apiKeys } from "@hot-updater/server/plugins/api-keys";
import { insights } from "@hot-updater/server/plugins/insights";
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
  expect(
    (await report({ installId: "install-1", type: "UPDATE_APPLIED" })).status,
  ).toBe(204);
  return release;
};

let database: ReturnType<typeof createDatabase>;

const configure = (config: {
  readonly database?: EngineDatabase | RemoteDatabase;
  readonly plugins?: readonly AnyHotUpdaterPlugin[];
}) => {
  vi.mocked(loadConfig).mockResolvedValue({ plugins: [], ...config } as never);
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
  vi.spyOn(console, "log").mockImplementation(() => {});
  database = createDatabase();
  configure({ database, plugins: [insights(), apiKeys()] });
});

afterEach(() => {
  process.exitCode = undefined;
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

    await handleInsightsEvents({ install: "install-1" });
    const printed = messages();
    expect(printed).toMatch(/Launched\s*│ install-1/u);
    expect(printed).toMatch(/Downloaded\s*│ install-1/u);
    expect(printed).not.toContain("install-2");

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
    await seed(database);

    await handleInsightsInstallations("install-1");
    const printed = messages();
    expect(printed).toContain("install-1");
    expect(printed).toMatch(/Latest:\s+Launched/u);

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
      'hot-updater.config.ts lists no insights() in plugins. Add insights() to plugins, the same plugin your server runs (import { insights } from "@hot-updater/server/plugins/insights"). A managed config gets it from the provider\'s plugins.',
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
