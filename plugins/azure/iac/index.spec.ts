import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAzureCli: vi.fn(),
  listSubscriptions: vi.fn(),
  readHotUpdaterInitEnv: vi.fn(),
  tasks: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    p: {
      ...actual.p,
      log: { error: vi.fn(), info: vi.fn(), step: vi.fn(), warn: vi.fn() },
      tasks: mocks.tasks,
    },
    readHotUpdaterInitEnv: mocks.readHotUpdaterInitEnv,
  };
});
vi.mock("./azureCli", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./azureCli")>()),
  azureCliVersion: async () => "2.70.0",
  createAzureCli: mocks.createAzureCli,
  listSubscriptions: mocks.listSubscriptions,
}));

import { runInit } from "./index";

const subscription = (id: string) => ({
  id,
  isDefault: false,
  name: id,
  state: "Enabled",
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listSubscriptions.mockResolvedValue([
    subscription("sub-file"),
    subscription("sub-env"),
  ]);
  // Stop once init has picked the subscription.
  mocks.tasks.mockRejectedValue(new Error("stop"));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Azure init", () => {
  it("reads an input the environment sets over the env files, as init's preflight does", async () => {
    const env = { HOT_UPDATER_AZURE_SUBSCRIPTION_ID: "sub-file" };
    mocks.readHotUpdaterInitEnv.mockResolvedValue({ env, managedEnv: env });
    vi.stubEnv("HOT_UPDATER_AZURE_SUBSCRIPTION_ID", "sub-env");

    await expect(
      runInit({ build: "bare", envFile: ".env.hotupdater" }),
    ).rejects.toThrow("stop");

    expect(mocks.createAzureCli).toHaveBeenCalledWith("sub-env");
  });
});
