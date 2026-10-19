import path from "node:path";

import { loadConfig, type ServerDefinition } from "@hot-updater/cli-tools";
import {
  type AnyHotUpdaterPlugin,
  createMemoryAdapter,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import {
  type VaultApi,
  vault,
  VaultLockedError,
} from "@hot-updater/server/plugins";
import { createReleaseCatalogTestStorage } from "@hot-updater/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadHotUpdater, type LoadHotUpdaterResult } from "./load-hot-updater";
import { withPluginServer } from "./open-server";

const { log } = vi.hoisted(() => ({ log: { error: vi.fn() } }));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  loadConfig: vi.fn(),
  p: { log },
}));

vi.mock("./load-hot-updater", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./load-hot-updater")>()),
  findDefaultConfigPaths: vi.fn(() => []),
  loadHotUpdater: vi.fn(),
}));

const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)));

/** A server definition whose vault holds the master key itself. */
const definitionWith = (
  plugins: readonly AnyHotUpdaterPlugin[],
): LoadHotUpdaterResult => ({
  hotUpdater: createHotUpdater({
    database: { name: "memory", adapter: createMemoryAdapter() },
    storage: createReleaseCatalogTestStorage(),
    plugins: [...plugins],
    ...(plugins.some(({ provides }) => provides?.clientAuth)
      ? {}
      : { clientAccess: "public" }),
  } as Parameters<typeof createHotUpdater>[0]) as unknown as ServerDefinition,
  adapterName: "memory",
  absoluteConfigPath: path.join(process.cwd(), "src/hotUpdater.ts"),
  dispose: vi.fn(async () => {}),
});

/** Seals a secret through the CLI's vault, then tries to read it back. */
const revealThroughCli = async (serverPath: string | undefined) => {
  let outcome: unknown;
  let listed: unknown;
  await withPluginServer(serverPath, async (server) => {
    const api = server.api?.["vault"] as VaultApi;
    const secret = await api.put({
      name: "release-keystore",
      kind: "android-keystore",
      value: { storePassword: "secret" },
    });
    listed = await api.list();
    outcome = await api.reveal({ id: secret.id, actor: "cli" }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  });
  return { outcome, listed };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("HOT_UPDATER_VAULT_MASTER_KEY", MASTER_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

describe("the CLI's vault", () => {
  it("refuses reveal over a server definition that passes vault({ masterKey })", async () => {
    vi.mocked(loadHotUpdater).mockResolvedValue(
      definitionWith([vault({ masterKey: MASTER_KEY })]),
    );

    const { outcome, listed } = await revealThroughCli("src/hotUpdater.ts");

    expect(listed).toMatchObject([{ name: "release-keystore" }]);
    expect(outcome).toEqual({ error: expect.any(VaultLockedError) });
    expect(process.exitCode).toBeUndefined();
  });

  it("refuses reveal over hot-updater.config.ts, with the master key in the env", async () => {
    vi.mocked(loadConfig).mockResolvedValue({
      database: { name: "memory", adapter: createMemoryAdapter() },
      storage: createReleaseCatalogTestStorage(),
      plugins: [vault()],
    } as never);

    const { outcome, listed } = await revealThroughCli(undefined);

    expect(listed).toMatchObject([{ name: "release-keystore" }]);
    expect(outcome).toEqual({ error: expect.any(VaultLockedError) });
    expect(loadHotUpdater).not.toHaveBeenCalled();
  });
});
