import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generate } from "./generate";
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
    info: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
  outro: vi.fn(),
  spinner: {
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

vi.mock("@hot-updater/cli-tools", () => ({
  p: {
    cancel: mockCli.cancel,
    confirm: mockCli.confirm,
    isCancel: mockCli.isCancel,
    log: mockCli.log,
    outro: mockCli.outro,
    spinner: vi.fn(() => mockCli.spinner),
  },
}));

vi.mock("./utils/load-hot-updater", () => ({
  loadHotUpdater: vi.fn(),
}));

describe("generate command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects MongoDB migration file generation with migrate guidance", async () => {
    const dispose = vi.fn();
    const loadedConfig: LoadHotUpdaterResult = {
      absoluteConfigPath: "/repo/src/db.ts",
      adapterName: "mongodb",
      dispose,
      hotUpdater: {
        adapterName: "mongodb",
      },
    };

    vi.mocked(loadHotUpdater).mockResolvedValue(loadedConfig);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    await expect(
      generate({ configPath: "src/db.ts", skipConfirm: true }),
    ).rejects.toThrow("process.exit(1)");

    expect(mockCli.spinner.stop).toHaveBeenCalledWith(
      "Generation not supported",
    );
    expect(mockCli.log.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "MongoDB does not support migration file generation.",
      ),
    );
    expect(mockCli.log.error).toHaveBeenCalledWith(
      expect.stringContaining("hot-updater db migrate"),
    );
    expect(dispose).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
