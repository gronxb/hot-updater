import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatOperations, migrate } from "./migrate";
import {
  loadHotUpdater,
  type LoadHotUpdaterResult,
} from "./utils/load-hot-updater";

const mockCli = vi.hoisted(() => ({
  cancel: vi.fn(),
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
  log: {
    error: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
  },
  spinner: {
    start: vi.fn(),
    stop: vi.fn(),
  },
}));
const mockServer = vi.hoisted(() => ({
  createMigrator: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", () => ({
  colors: {
    blue: (value: string) => value,
    bold: (value: string) => value,
    cyan: (value: string) => value,
    dim: (value: string) => value,
    green: (value: string) => value,
    magenta: (value: string) => value,
    red: (value: string) => value,
    yellow: (value: string) => value,
  },
  p: {
    cancel: mockCli.cancel,
    confirm: mockCli.confirm,
    isCancel: mockCli.isCancel,
    log: mockCli.log,
    spinner: vi.fn(() => mockCli.spinner),
  },
}));

vi.mock("./utils/load-hot-updater", () => ({
  loadHotUpdater: vi.fn(),
}));

vi.mock("@hot-updater/server/db", () => ({
  createMigrator: mockServer.createMigrator,
}));

describe("migrate command operation formatting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders custom SQL and setting operations", () => {
    expect(
      formatOperations([
        {
          type: "custom",
          sql: "create index bundles_channel_idx on bundles(channel)",
        },
        {
          type: "custom",
          key: "version",
          value: "0.31.0",
        },
      ]),
    ).toEqual([
      "Run SQL: create index bundles_channel_idx on bundles(channel)",
      "Set setting: version=0.31.0",
    ]);
  });

  it("runs MongoDB migrations through the native migrator path", async () => {
    const execute = vi.fn(async () => undefined);
    const getVersion = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("0.34.0");
    const migrateToLatest = vi.fn(async () => ({
      execute,
      operations: [
        {
          type: "custom",
          sql: "create index bundles_id_idx on bundles(id)",
        },
      ],
    }));
    const loadedConfig: LoadHotUpdaterResult = {
      absoluteConfigPath: "/repo/src/db.ts",
      adapterName: "mongodb",
      dispose: vi.fn(),
      hotUpdater: {
        adapterName: "mongodb",
      },
    };
    mockServer.createMigrator.mockReturnValue({
      getVersion,
      migrateToLatest,
    });
    vi.mocked(loadHotUpdater).mockResolvedValue(loadedConfig);

    await migrate({ configPath: "src/db.ts", skipConfirm: true });

    expect(mockServer.createMigrator).toHaveBeenCalledWith(
      loadedConfig.hotUpdater,
    );
    expect(migrateToLatest).toHaveBeenCalledWith({
      mode: "from-schema",
      updateSettings: true,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(mockCli.log.success).toHaveBeenCalledWith("Migrated to 0.34.0");
    expect(loadedConfig.dispose).toHaveBeenCalledOnce();
  });
});
