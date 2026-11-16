import {
  createEngineDatabase,
  createMemoryAdapter,
  migrateCoreSchema,
  SETTINGS_TABLE,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { createReleaseCatalogTestStorage } from "@hot-updater/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { testServer } from "../utils/testServer";
import { handlePartitionCatalogs } from "./partitionCatalogs";

const { loadConfig, loadServer, log } = vi.hoisted(() => ({
  loadConfig: vi.fn(async () => ({})),
  loadServer: vi.fn(),
  log: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return { ...actual, loadConfig, p: { ...actual.p, log: { ...actual.p.log, ...log } } };
});
vi.mock("@/utils/loadServer", async () => ({
  ...(await vi.importActual<typeof import("../utils/loadServer")>(
    "../utils/loadServer",
  )),
  loadServer,
}));
vi.mock("../utils/printBanner", () => ({ printBanner: vi.fn() }));

const SERVER_URL = "https://abc.supabase.co/functions/v1/hot-updater";

/** A managed project: the config names the server's database; the server is deployed at SERVER_URL. */
const managed = async ({ serverVersion }: { serverVersion: "1.2" | "1.1" }) => {
  const adapter = createMemoryAdapter();
  await migrateCoreSchema(adapter, "memory");
  const database = createEngineDatabase({ name: "memory", adapter });
  const deployed = createHotUpdater({
    clientAccess: "public",
    database,
    storage: createReleaseCatalogTestStorage(),
  });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (serverVersion === "1.1") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    return deployed.handlers.client(
      new Request(
        `http://localhost${url.pathname.replace("/functions/v1/hot-updater", "")}`,
        init,
      ),
    );
  });
  // The command closes its database; a memory adapter's close empties it,
  // and the server process keeps the same store open.
  loadServer.mockResolvedValue(
    testServer({ database: { ...database, dispose: async () => {} } }),
  );
  return async () =>
    (await adapter.get(SETTINGS_TABLE, [["catalog.partitioning"]]))[0]
      ?.["value"] ?? null;
};

describe("db partition-catalogs", () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it("asks the deployed server, which turns partitioning on; a second run says it already is", async () => {
    const switchValue = await managed({ serverVersion: "1.2" });
    await handlePartitionCatalogs({ serverUrl: SERVER_URL, yes: true });
    expect(await switchValue()).toBe("on");
    expect(log.success).toHaveBeenLastCalledWith(
      "Release catalogs are partitioned from now on.\nEach app-version scope converts on its next write.",
    );
    await handlePartitionCatalogs({ serverUrl: SERVER_URL, yes: true });
    expect(log.success).toHaveBeenLastCalledWith(
      "Release catalogs are already partitioned.",
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("refuses a 1.1 server with one line, and the switch stays unset", async () => {
    const switchValue = await managed({ serverVersion: "1.1" });
    await handlePartitionCatalogs({ serverUrl: SERVER_URL, yes: true });
    expect(log.error).toHaveBeenCalledWith(
      `Partitioning stays off: ${SERVER_URL} runs Hot Updater before 1.2.0. Deploy 1.2.0 to every server first.`,
    );
    expect(process.exitCode).toBe(1);
    expect(await switchValue()).toBeNull();
  });

  it("can't enable from a direct database without a server", async () => {
    const switchValue = await managed({ serverVersion: "1.2" });
    await handlePartitionCatalogs({ yes: true });
    expect(log.error).toHaveBeenCalledWith(
      "Partitioning stays off: Name the server apps check for updates at with --server-url <url>.",
    );
    expect(process.exitCode).toBe(1);
    expect(await switchValue()).toBeNull();
  });
});
